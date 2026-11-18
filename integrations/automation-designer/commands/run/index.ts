import { apiFetch, CliError, type CommandModule, defineArgs, ok, printErr, redactSecrets, redactString } from "@belzabar/core";
import { AD_YES_FLAG } from "../../lib/args/common";
import { requireConfirmation } from "../../lib/args/confirm";
import { repeatStats, type RepeatStats } from "../../lib/repeat";
import { executionError } from "../../lib/exec-error";
import { readStream } from "../../lib/stream-parser";
import { adApi } from "../../lib/api/index";
import { AD_LONG_OP_TIMEOUT_MS } from "../../lib/api/v1";
import { resolveMethodRef } from "@belzabar/core/platform";
import { calleeDrafts, ranVersionOf, runWarnings, unpublishedDraftOf, type RanVersion } from "../../lib/run-context";
import type { MethodState } from "../../lib/types/common";

interface RunMethodArgs {
  publishedId: string;
  payloadArg?: string;
  raw: boolean;
  stream: boolean;
  repeat: number;
  yes: boolean;
}

interface RunMethodData {
  publishedId: string;
  /** State of the uuid passed. null if it could not be read. */
  inputState: MethodState | null;
  /**
   * When a DRAFT uuid was passed: its published copy (null: never published).
   * The execute endpoint runs the uuid's OWN saved body, so a draft uuid runs
   * the draft (unpublished changes included), not this copy (verified live).
   */
  publishedUuid?: string | null;
  /** The copy that ran (the uuid's own body): `PUBLISHED v47`; null if it could not be read. */
  ranVersion: RanVersion | null;
  path: string;
  payloadType: string;
  response: unknown;
  responseFormat: "json" | "text" | "stream";
  /** Progressive chunks — present only when responseFormat === "stream". */
  streamChunks?: string[];
  /** Final envelope of a streaming response — present only when streaming. */
  finalResponse?: unknown;
  /** --repeat N: every run's times (response is the first run's). serverMs: executionStatus.totalExecutionTime. */
  repeat?: { runs: number; serverMs: RepeatStats | null; wallMs: RepeatStats };
  raw?: {
    payload: unknown;
  };
}

/** A response's `executionStatus.totalExecutionTime` in ms, when it has one. */
function serverMs(json: unknown): number | null {
  const t = (json as { executionStatus?: { totalExecutionTime?: { time?: unknown; unit?: unknown } } } | null)?.executionStatus?.totalExecutionTime;
  if (!t || typeof t.time !== "number") return null;
  return t.unit === "seconds" ? t.time * 1000 : t.unit === "nanoseconds" ? t.time / 1e6 : t.time;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function resolvePayload(payloadArg?: string): Promise<unknown> {
  if (!payloadArg) {
    return {};
  }

  // Inline JSON is never a file name: a long one would fail the file lookup (ENAMETOOLONG).
  const trimmed = payloadArg.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(payloadArg);
    } catch (err) {
      throw new CliError(`Payload argument starts with ${trimmed[0]} but is not valid JSON: ${(err as Error).message}`, { code: "INVALID_PAYLOAD" });
    }
  }

  const file = Bun.file(payloadArg);
  if (await file.exists()) {
    try {
      return await file.json();
    } catch (err) {
      throw new CliError(`Payload file ${payloadArg} is not valid JSON: ${(err as Error).message}`, { code: "INVALID_PAYLOAD", details: { path: payloadArg } });
    }
  }

  try {
    return JSON.parse(payloadArg);
  } catch {
    throw new CliError("Payload argument is neither a valid file path nor valid JSON string.", {
      code: "INVALID_PAYLOAD",
    });
  }
}

/**
 * Same redaction as `ad test`: credentials in the output (a file link's live
 * `?token=…`, echoed auth headers, JWTs) become [REDACTED], so a saved
 * baseline never holds a working login. Only header keys are blanked: a
 * method's own `token` / `password` output fields are data.
 */
function redact<T>(value: T): T {
  return redactSecrets(value, { keys: "headers" });
}

export const args = defineArgs({
  command: "wi-impl ad run",
  positionals: [
    { name: "published-id", required: true, missingCode: "MISSING_PUBLISHED_ID", missingMessage: "Missing Published ID." },
    { name: "payload" },
  ],
  flags: {
    ...AD_YES_FLAG,
    raw: { type: "boolean" },
    stream: { type: "boolean" },
    repeat: { type: "number", integer: true, min: 1, max: 100, default: 1 },
  },
  exclusive: [["stream", "repeat"]],
});

const command: CommandModule<RunMethodArgs, RunMethodData> = {
  // Executes a live method with real side effects: explicit --env required.
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      publishedId: positionals.publishedId,
      payloadArg: positionals.payload,
      raw: flags.raw,
      stream: flags.stream,
      repeat: flags.repeat,
      yes: flags.yes,
    };
  },
  async execute({ publishedId: idArg, payloadArg, raw, stream, repeat, yes }, context) {
    const publishedId = resolveMethodRef(idArg);
    const payload = await resolvePayload(payloadArg);

    // A DRAFT uuid executes the draft's own saved body (unpublished changes
    // included), not the published copy: say so, and name the published copy.
    let inputState: MethodState | null = null;
    let publishedUuid: string | null | undefined;
    let ranVersion: RanVersion | null = null;
    try {
      const m = await adApi.fetchMethod(publishedId, "v1");
      inputState = m.state;
      ranVersion = ranVersionOf(m);
      // a published uuid whose draft moved on, and callees whose drafts do not run here
      const [own, callees] = await Promise.all([unpublishedDraftOf(m), calleeDrafts(m)]);
      for (const w of runWarnings(m, own, callees)) context.warn(w);
      if (m.state === "DRAFT") {
        publishedUuid = (m.referenceId ?? "").trim() || null;
        context.warn(
          publishedUuid
            ? `${publishedId} is a DRAFT: this runs the draft's saved body (unpublished changes included), not the published copy ${publishedUuid}. Pass ${publishedUuid} to run what is published.`
            : `${publishedId} is a DRAFT that was never published: this runs the draft's saved body.`,
        );
      }
    } catch (e) {
      if (e instanceof CliError && e.code === "METHOD_NOT_FOUND") throw e;
      // state unknown — execute anyway (reported as inputState:null)
    }
    if (!payloadArg) {
      context.warn("No payload provided. Using empty object '{}'.");
    }

    if (repeat > 1) {
      await requireConfirmation({
        yes,
        outputMode: context.outputMode,
        action: `execute the method ${repeat} times (--repeat), with real side effects every time`,
        details: [["Method", `${publishedId}${ranVersion ? ` (${ranVersion.label})` : ""}`]],
      });
    }

    const path = `/rest/api/automation/chain/execute/${publishedId}?encrypted=true`;
    const execute = async () => {
      const res = await apiFetch(path, {
        method: "POST",
        authMode: "Raw",
        ...(stream ? { headers: { Accept: "application/stream+json" } } : {}),
        body: JSON.stringify(payload),
        // Long-running methods; a stream stays open for as long as the method runs.
        timeoutMs: stream ? "none" : AD_LONG_OP_TIMEOUT_MS,
      });
      // error.message carries the method's own message and failing step; details.body is the
      // decoded (redacted) body, or, when long, details.bodyFile holds it whole.
      if (!res.ok) throw await executionError(res, { code: "EXECUTION_FAILED", label: "Execution failed", path, tag: "ad-run" });
      return res;
    };
    const started = Date.now();
    const response = await execute();

    const payloadType = Array.isArray(payload) ? "array" : typeof payload;
    // Streaming is strictly opt-in: without --stream the response is always
    // handled by the buffered JSON/text path, exactly as before this flag existed.
    const contentType = response.headers.get("content-type") ?? "";
    const isStream = stream && contentType.includes("stream+json");

    if (isStream) {
      const result = await readStream(response, (line) => {
        if (context.outputMode === "human") {
          process.stderr.write(`  ⟩ ${redactString(line)}\n`);
        }
      });
      const final = redact(result.final);
      const data: RunMethodData = {
        publishedId,
        inputState,
        ...(publishedUuid !== undefined ? { publishedUuid } : {}),
        ranVersion,
        path,
        payloadType,
        response: final,
        responseFormat: "stream",
        streamChunks: result.chunks.map(redactString),
        finalResponse: final,
      };
      if (raw) data.raw = { payload };
      return ok(data);
    }

    const text = await response.text();
    let timing: RunMethodData["repeat"];
    if (repeat > 1) {
      const wall = [Date.now() - started];
      const server = [serverMs(parseJson(text))];
      for (let i = 1; i < repeat; i++) {
        const t0 = Date.now();
        const again = await (await execute()).text();
        wall.push(Date.now() - t0);
        server.push(serverMs(parseJson(again)));
        printErr(`run ${i + 1}/${repeat}: server ${server[i] != null ? `${Math.round(server[i]!)}ms` : "-"}, wall ${wall[i]}ms`);
      }
      const known = server.filter((x): x is number => x != null);
      timing = { runs: repeat, serverMs: known.length ? repeatStats(known) : null, wallMs: repeatStats(wall) };
    }
    try {
      const json = JSON.parse(text);
      const data: RunMethodData = {
        publishedId,
        inputState,
        ...(publishedUuid !== undefined ? { publishedUuid } : {}),
        ranVersion,
        path,
        payloadType,
        response: redact(json),
        responseFormat: "json",
      };
      if (timing) data.repeat = timing;
      if (raw) data.raw = { payload };
      return ok(data);
    } catch {
      const data: RunMethodData = {
        publishedId,
        inputState,
        ...(publishedUuid !== undefined ? { publishedUuid } : {}),
        ranVersion,
        path,
        payloadType,
        response: redactString(text),
        responseFormat: "text",
      };
      if (timing) data.repeat = timing;
      if (raw) data.raw = { payload };
      return ok(data);
    }
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as RunMethodData;
    ui.success(`Method executed: ${data.publishedId}${data.ranVersion ? ` (${data.ranVersion.label})` : ""}`);
    ui.table(
      ["Property", "Value"],
      [
        ["Path", data.path],
        ["Payload Type", data.payloadType],
        ["Response Format", data.responseFormat],
      ]
    );
    if (data.responseFormat === "stream" && data.streamChunks && data.streamChunks.length > 0) {
      ui.section(`Stream Chunks (${data.streamChunks.length})`);
      for (const chunk of data.streamChunks) ui.text(chunk);
    }
    if (data.repeat) {
      const r = data.repeat;
      const line = (x: RepeatStats | null) => (x ? `min ${Math.round(x.min)}ms, median ${Math.round(x.median)}ms, max ${Math.round(x.max)}ms` : "-");
      ui.section(`Repeat (${r.runs} runs)`);
      ui.text(`Server time: ${line(r.serverMs)}`);
      ui.text(`Wall time:   ${line(r.wallMs)}`);
    }
    ui.section(data.responseFormat === "stream" ? "Final Response" : "Execution Result");
    ui.object(data.response);
    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
