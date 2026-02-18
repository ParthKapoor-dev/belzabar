import { CliError, ok, type CommandModule } from "@belzabar/core";
import { apiFetch } from "../../lib/api";

interface RunMethodArgs {
  publishedId: string;
  payloadArg?: string;
  raw: boolean;
}

interface RunMethodData {
  publishedId: string;
  path: string;
  payloadType: string;
  response: unknown;
  responseFormat: "json" | "text";
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
  schema: "ad.run-method",
  parseArgs(args) {
    const raw = args.includes("--raw");
    const positional = args.filter(arg => arg !== "--raw");
    const publishedId = positional[0];
    if (!publishedId || publishedId.startsWith("-")) {
      throw new CliError("Missing Published ID.", { code: "MISSING_PUBLISHED_ID" });
    }
    return {
      publishedId,
      payloadArg: positional[1],
      raw,
    };
  },
  async execute({ publishedId, payloadArg, raw }, context) {
    const payload = await resolvePayload(payloadArg);
    if (!payloadArg) {
      context.warn("No payload provided. Using empty object '{}'.");
    }

    const path = `/rest/api/automation/chain/execute/${publishedId}?encrypted=true`;
    const response = await apiFetch(path, {
      method: "POST",
      authMode: "Raw",
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new CliError(`Execution failed (${response.status})`, {
        code: "EXECUTION_FAILED",
        details: text,
      });
    }

    try {
      const json = JSON.parse(text);
      const data: RunMethodData = {
        publishedId,
        path,
        payloadType: Array.isArray(payload) ? "array" : typeof payload,
        response: json,
        responseFormat: "json",
      };
      if (raw) data.raw = { payload };
      return ok(data);
    } catch {
      const data: RunMethodData = {
        publishedId,
        path,
        payloadType: Array.isArray(payload) ? "array" : typeof payload,
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
    ui.section("Execution Result");
    ui.object(data.response);
    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
