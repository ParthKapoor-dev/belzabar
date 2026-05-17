import { CliError, ok, apiFetch, type CommandModule } from "@belzabar/core";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import { readStream } from "../../lib/stream-parser";

interface RunMethodArgs {
  publishedId: string;
  payloadArg?: string;
  raw: boolean;
  stream: boolean;
}

interface RunMethodData {
  publishedId: string;
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
    return await file.json();
  }

  try {
    return JSON.parse(payloadArg);
  } catch {
    throw new CliError("Payload argument is neither a valid file path nor valid JSON string.", {
      code: "INVALID_PAYLOAD",
    });
  }
}

const command: CommandModule<RunMethodArgs, RunMethodData> = {
  schema: "ad.run",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "run", "run");
    emitFallbackWarning(common, "run");
    const raw = rest.includes("--raw");
    const stream = rest.includes("--stream");
    const positional = rest.filter(arg => arg !== "--raw" && arg !== "--stream");
    const publishedId = positional[0];
    if (!publishedId || publishedId.startsWith("-")) {
      throw new CliError("Missing Published ID.", { code: "MISSING_PUBLISHED_ID" });
    }
    return {
      publishedId,
      payloadArg: positional[1],
      raw,
      stream,
    };
  },
  async execute({ publishedId, payloadArg, raw, stream }, context) {
    const payload = await resolvePayload(payloadArg);
    if (!payloadArg) {
      context.warn("No payload provided. Using empty object '{}'.");
    }

    const path = `/rest/api/automation/chain/execute/${publishedId}?encrypted=true`;
    const response = await apiFetch(path, {
      method: "POST",
      authMode: "Raw",
      ...(stream ? { headers: { Accept: "application/stream+json" } } : {}),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new CliError(`Execution failed (${response.status})`, {
        code: "EXECUTION_FAILED",
        details: errText,
      });
    }

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
