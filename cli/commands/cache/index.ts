import {
  apiFetch,
  Config,
  CliError,
  ok,
  lifecycle,
  prompts,
  type CommandModule,
} from "@belzabar/core";

const CACHE_INVALIDATE_PATH = "/rest/api/cache/invalidate";
const DEFAULT_TYPE = "AUTOMATION";

interface CacheArgs {
  uuids: string[];
  type: string;
  yes: boolean;
}

interface CacheData {
  env: string;
  type: string;
  scope: "all" | "uuids";
  uuidCount: number;
  uuids: string[];
  status: number;
  response: unknown;
}

function parseUuids(rest: string[]): string[] {
  return rest.map(u => u.trim()).filter(u => u.length > 0);
}

const command: CommandModule<CacheArgs, CacheData> = {
  schema: "belz.cache",

  parseArgs(args) {
    const positional: string[] = [];
    let type = DEFAULT_TYPE;
    let yes = false;

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i] ?? "";
      if (token === "--yes" || token === "-y") {
        yes = true;
        continue;
      }
      if (token === "--type") {
        const value = args[i + 1];
        if (!value || value.startsWith("-")) {
          throw new CliError("--type requires a value (e.g. --type AUTOMATION).", {
            code: "MISSING_TYPE_VALUE",
          });
        }
        type = value;
        i += 1;
        continue;
      }
      if (token.startsWith("--type=")) {
        type = token.slice("--type=".length);
        if (!type) {
          throw new CliError("--type= requires a non-empty value.", {
            code: "MISSING_TYPE_VALUE",
          });
        }
        continue;
      }
      if (token.startsWith("-")) {
        throw new CliError(`Unknown flag: ${token}`, { code: "UNKNOWN_FLAG" });
      }
      positional.push(token);
    }

    return { uuids: parseUuids(positional), type, yes };
  },

  async execute(args, context) {
    const scope: CacheData["scope"] = args.uuids.length === 0 ? "all" : "uuids";
    const envName = context.env.name;

    if (scope === "all" && !args.yes) {
      if (context.outputMode === "llm") {
        throw new CliError(
          `Refusing to invalidate the entire '${args.type}' cache for '${envName}' without --yes.`,
          {
            code: "CACHE_CONFIRMATION_REQUIRED",
            details: { env: envName, type: args.type, scope },
          },
        );
      }
      lifecycle.note(
        "About to invalidate the ENTIRE cache",
        [
          `Environment   ${envName}`,
          `Base URL      ${Config.cleanBaseUrl}`,
          `Cache type    ${args.type}`,
          `Scope         all entries (no UUIDs supplied)`,
        ].join("\n"),
      );
      const confirmed = await prompts.confirm({
        message: "Proceed?",
        initialValue: false,
      });
      if (!confirmed) {
        throw new CliError("Aborted by user.", { code: "USER_ABORT" });
      }
    }

    const body: Record<string, unknown> = { type: args.type };
    if (scope === "uuids") body.uuid = args.uuids;

    const spin = lifecycle.spinner("Invalidating cache");
    spin.start(
      scope === "all"
        ? `Invalidating all '${args.type}' entries on ${envName}…`
        : `Invalidating ${args.uuids.length} '${args.type}' entr${args.uuids.length === 1 ? "y" : "ies"} on ${envName}…`,
    );

    let response: Response;
    try {
      response = await apiFetch(CACHE_INVALIDATE_PATH, {
        method: "POST",
        authMode: "Bearer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      spin.error("Cache invalidate request failed.");
      throw err;
    }

    if (!response.ok) {
      let details: unknown;
      try {
        const text = await response.text();
        try {
          details = JSON.parse(text);
        } catch {
          details = text.slice(0, 1024);
        }
      } catch {
        details = "(response body unreadable)";
      }
      spin.error(`Cache invalidate failed (${response.status}).`);
      throw new CliError(`${response.status} ${response.statusText} on ${CACHE_INVALIDATE_PATH}`, {
        code: "CACHE_API_ERROR",
        details: { path: CACHE_INVALIDATE_PATH, status: response.status, body: details },
      });
    }

    let parsed: unknown;
    const text = await response.text();
    if (text.length === 0) {
      parsed = null;
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    spin.stop("Cache invalidate request complete.");

    return ok<CacheData>({
      env: envName,
      type: args.type,
      scope,
      uuidCount: args.uuids.length,
      uuids: args.uuids,
      status: response.status,
      response: parsed,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as CacheData;
    const target =
      data.scope === "all"
        ? `entire '${data.type}' cache`
        : `${data.uuidCount} '${data.type}' entr${data.uuidCount === 1 ? "y" : "ies"}`;
    ui.success(`Invalidated ${target} on ${data.env}.`);
    ui.table(
      ["Property", "Value"],
      [
        ["Environment", data.env],
        ["Type", data.type],
        ["Scope", data.scope === "all" ? "all entries" : "by UUID"],
        ["UUIDs", data.scope === "all" ? "(all)" : String(data.uuidCount)],
        ["HTTP status", String(data.status)],
      ],
    );
    if (data.scope === "uuids" && data.uuids.length > 0) {
      ui.section("Invalidated UUIDs");
      for (const u of data.uuids) ui.text(u);
    }
    if (data.response !== null && data.response !== "") {
      ui.section("Server response");
      ui.object(data.response);
    }
  },
};

export default command;
