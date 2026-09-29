import { apiFetch, CliError, type CommandModule, defineArgs, ensureApiOk, ok } from "@belzabar/core";
import { readStream } from "../../lib/stream-parser";
import { adApi } from "../../lib/api/index";
import { AD_LONG_OP_TIMEOUT_MS } from "../../lib/api/v1";
import { resolveMethodRef } from "@belzabar/core/platform";
import type { MethodState } from "../../lib/types/common";

interface RunMethodArgs {
  publishedId: string;
  payloadArg?: string;
  raw: boolean;
  stream: boolean;
}

interface RunMethodData {
  publishedId: string;
  /** State of the uuid passed. null if it could not be read. */
  inputState: MethodState | null;
  /**
   * When a DRAFT uuid was passed: its published copy (null: never published).
   * The execute endpoint runs the uuid's OWN saved body, so a draft uuid runs
   * the draft (unpublished changes included), not this copy — live
   * 2026-09-29 (AD-34's "runs the published body" did not reproduce).
   */
  publishedUuid?: string | null;
  path: string;
  payloadType: string;
  response: unknown;
  responseFormat: "json" | "text" | "stream";
  /** Progressive chunks — present only when responseFormat === "stream". */
  streamChunks?: string[];
  /** Final envelope of a streaming response — present only when streaming. */
  finalResponse?: unknown;
  raw?: {
    payload: unknown;
  };
}

async function resolvePayload(payloadArg?: string): Promise<unknown> {
  if (!payloadArg) {
    return {};
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

export const args = defineArgs({
  command: "belz ad run",
  positionals: [
    { name: "published-id", required: true, missingCode: "MISSING_PUBLISHED_ID", missingMessage: "Missing Published ID." },
    { name: "payload" },
  ],
  flags: {
    raw: { type: "boolean" },
    stream: { type: "boolean" },
  },
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
    };
  },
  async execute({ publishedId: idArg, payloadArg, raw, stream }, context) {
    const publishedId = resolveMethodRef(idArg);
    const payload = await resolvePayload(payloadArg);

    // A DRAFT uuid executes the draft's own saved body (unpublished changes
    // included), not the published copy: say so, and name the published copy.
    let inputState: MethodState | null = null;
    let publishedUuid: string | null | undefined;
    try {
      const m = await adApi.fetchMethod(publishedId, "v1");
      inputState = m.state;
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

    const path = `/rest/api/automation/chain/execute/${publishedId}?encrypted=true`;
    const response = await apiFetch(path, {
      method: "POST",
      authMode: "Raw",
      ...(stream ? { headers: { Accept: "application/stream+json" } } : {}),
      body: JSON.stringify(payload),
      // Long-running methods; a stream stays open for as long as the method runs.
      timeoutMs: stream ? "none" : AD_LONG_OP_TIMEOUT_MS,
    });

    // details.body is an object (parsed + redacted body), never a raw string.
    await ensureApiOk(response, { path, code: "EXECUTION_FAILED", message: (res) => `Execution failed (${res.status})` });

    const payloadType = Array.isArray(payload) ? "array" : typeof payload;
    // Streaming is strictly opt-in: without --stream the response is always
    // handled by the buffered JSON/text path, exactly as before this flag existed.
    const contentType = response.headers.get("content-type") ?? "";
    const isStream = stream && contentType.includes("stream+json");

    if (isStream) {
      const result = await readStream(response, (line) => {
        if (context.outputMode === "human") {
          process.stderr.write(`  ⟩ ${line}\n`);
        }
      });
      const data: RunMethodData = {
        publishedId,
        inputState,
        ...(publishedUuid !== undefined ? { publishedUuid } : {}),
        path,
        payloadType,
        response: result.final,
        responseFormat: "stream",
        streamChunks: result.chunks,
        finalResponse: result.final,
      };
      if (raw) data.raw = { payload };
      return ok(data);
    }

    const text = await response.text();
    try {
      const json = JSON.parse(text);
      const data: RunMethodData = {
        publishedId,
        inputState,
        ...(publishedUuid !== undefined ? { publishedUuid } : {}),
        path,
        payloadType,
        response: json,
        responseFormat: "json",
      };
      if (raw) data.raw = { payload };
      return ok(data);
    } catch {
      const data: RunMethodData = {
        publishedId,
        inputState,
        ...(publishedUuid !== undefined ? { publishedUuid } : {}),
        path,
        payloadType,
        response: text,
        responseFormat: "text",
      };
      if (raw) data.raw = { payload };
      return ok(data);
    }
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as RunMethodData;
    ui.success(`Method executed: ${data.publishedId}`);
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
    ui.section(data.responseFormat === "stream" ? "Final Response" : "Execution Result");
    ui.object(data.response);
    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
