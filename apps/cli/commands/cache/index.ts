import {
  apiFetch,
  Config,
  CliError,
  defineArgs,
  ok,
  lifecycle,
  type CommandModule,
} from "@belzabar/core";

/**
 * Both routes are POSTed on every invalidate. On a tenant routed through micro-AD the
 * monolith route answers 200 without evicting the compiled chain; the `/automations/`
 * route owns it there (and 404/500s on a monolith tenant). A 2xx proves the endpoint
 * exists, not that it held the cache — so call both, succeed if ANY returns 2xx, and
 * report each route's result. Mirrors the team's live-verified save-and-test.py.
 */
export const CACHE_INVALIDATE_PATHS = [
  "/rest/api/cache/invalidate",
  "/rest/api/automations/cache/invalidate",
] as const;
const DEFAULT_TYPE = "AUTOMATION";

interface CacheArgs {
  uuids: string[];
  type: string;
  yes: boolean;
  all: boolean;
}

export interface RouteResult {
  path: string;
  ok: boolean;
  status: number | null;
  response?: unknown;
  error?: string;
}

interface CacheData {
  env: string;
  type: string;
  scope: "all" | "uuids";
  uuidCount: number;
  uuids: string[];
  routes: RouteResult[];
}

type Fetcher = (path: string, options: Parameters<typeof apiFetch>[1]) => Promise<Response>;

function parseUuids(rest: string[]): string[] {
  return rest.map(u => u.trim()).filter(u => u.length > 0);
}

/**
 * Request body. The server key is `uuids` (plural). An empty or absent `uuids` list
 * means "flush every entry of this type for the whole org" — callers must only build
 * that deliberately (scope "all").
 */
export function buildInvalidateBody(uuids: string[], type: string): { uuids: string[]; type: string } {
  return { uuids: [...uuids], type };
}

async function readBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 1024);
    }
  } catch {
    return "(response body unreadable)";
  }
}

/** POST the body to every invalidate route. Never throws; one route failing is tolerated. */
export async function invalidateOnAllRoutes(
  body: { uuids: string[]; type: string },
  fetcher: Fetcher = apiFetch,
): Promise<RouteResult[]> {
  const results: RouteResult[] = [];
  for (const path of CACHE_INVALIDATE_PATHS) {
    try {
      const response = await fetcher(path, {
        method: "POST",
        authMode: "Bearer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      results.push({ path, ok: response.ok, status: response.status, response: await readBody(response) });
    } catch (err: any) {
      results.push({ path, ok: false, status: null, error: err?.message ?? String(err) });
    }
  }
  return results;
}

export const args = defineArgs({
  command: "belz cache",
  positionals: [{ name: "uuids", variadic: true }],
  flags: {
    type: { type: "string", default: DEFAULT_TYPE },
    all: { type: "boolean" },
    yes: { type: "boolean", alias: ["-y"] },
  },
});

const command: CommandModule<CacheArgs, CacheData> = {
  schema: "belz.cache",

  /** Invalidates server-side cache entries on the target environment. */
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const { type, yes, all } = flags;
    const uuids = parseUuids(positionals.uuids);
    if (all && uuids.length > 0) {
      throw new CliError("--all cannot be combined with UUIDs.", { code: "INVALID_ARGS" });
    }
    if (uuids.length === 0 && !all) {
      throw new CliError(
        "No UUIDs given. An invalidate without UUIDs flushes the whole org's cache; pass --all --yes to do that deliberately.",
        { code: "MISSING_UUIDS" },
      );
    }
    if (all && !yes) {
      throw new CliError(
        `Refusing to invalidate the entire '${type}' cache without --yes (use --all --yes).`,
        { code: "CACHE_CONFIRMATION_REQUIRED", details: { type, scope: "all" } },
      );
    }

    return { uuids, type, yes, all };
  },

  async execute(args, context) {
    // parseArgs already enforces this; re-check so a direct execute() call cannot flush the org.
    if (args.uuids.length === 0 && !(args.all && args.yes)) {
      throw new CliError("Refusing an invalidate with no UUIDs unless --all --yes is passed.", {
        code: "CACHE_CONFIRMATION_REQUIRED",
      });
    }
    const scope: CacheData["scope"] = args.uuids.length === 0 ? "all" : "uuids";
    const envName = context.env.name;
    const body = buildInvalidateBody(args.uuids, args.type);

    const spin = lifecycle.spinner("Invalidating cache");
    spin.start(
      scope === "all"
        ? `Invalidating all '${args.type}' entries on ${envName} (${Config.cleanBaseUrl})…`
        : `Invalidating ${args.uuids.length} '${args.type}' entr${args.uuids.length === 1 ? "y" : "ies"} on ${envName}…`,
    );

    const routes = await invalidateOnAllRoutes(body);

    if (!routes.some(r => r.ok)) {
      spin.error("Cache invalidate failed on every route.");
      throw new CliError(
        `Cache invalidate failed on all routes: ${routes.map(r => `${r.path} → ${r.status ?? r.error}`).join("; ")}`,
        { code: "CACHE_API_ERROR", details: { routes } },
      );
    }
    for (const r of routes.filter(r => !r.ok)) {
      context.warn(`${r.path} did not succeed (${r.status ?? r.error}); another route did.`);
    }
    spin.stop("Cache invalidate request complete.");

    return ok<CacheData>({
      env: envName,
      type: args.type,
      scope,
      uuidCount: args.uuids.length,
      uuids: args.uuids,
      routes,
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
      ],
    );
    ui.section("Routes");
    ui.table(
      ["Route", "Result"],
      data.routes.map(r => [r.path, r.ok ? `ok (${r.status})` : `failed (${r.status ?? r.error})`]),
    );
    if (data.scope === "uuids" && data.uuids.length > 0) {
      ui.section("Invalidated UUIDs");
      for (const u of data.uuids) ui.text(u);
    }
  },
};

export default command;
