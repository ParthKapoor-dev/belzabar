import { readdirSync, rmSync, statSync } from "fs";
import { join, relative } from "path";
import type { Dirent, Stats } from "fs";
import {
  BELZ_CONFIG_DIR,
  Config,
  CliError,
  defineSubcommands,
  ok,
  lifecycle,
  type CommandContext,
  type CommandResult,
  type HumanPresenterHelpers,
  type CommandModule,
} from "@belzabar/core";
import {
  CACHE_INVALIDATE_PATHS,
  clearServerCache,
  invalidateOnAllRoutes,
  isEntityId,
  type CacheClearRound,
  type CacheRouteResult,
} from "@belzabar/core/platform";

// The invalidate routes and the repeated clear live in core (`migrate run` uses
// them too): see packages/core/src/platform/server-cache.ts.
export { CACHE_INVALIDATE_PATHS, invalidateOnAllRoutes };
export type RouteResult = CacheRouteResult;
const DEFAULT_TYPE = "AUTOMATION";
/** Upper bound on `--repeat` (rounds are 1 s apart). */
const MAX_REPEAT = 50;

/** Refresh locks TTL out after 30s (see core `swr.ts`); anything older is an abandoned lock. */
const STALE_LOCK_AGE_MS = 10 * 60 * 1000;
/** Cap on the item list embedded in the envelope; `truncated` reports the rest. */
const SAMPLE_LIMIT = 25;

/**
 * Cache namespaces whose cache key already encodes the env, so their files are
 * intentionally flat (`<namespace>/<key>.json`, never `<namespace>/<env>/<key>.json`).
 * See `envScoped: false` in `integrations/automation-designer/lib/method-finder.ts`
 * and `integrations/page-designer/lib/page-finder.ts`. `prune-local` must never
 * treat these as pre-env-scoping leftovers. Update this set if another cache opts
 * out of env-scoping.
 */
const UNSCOPED_NAMESPACES = new Set(["method-finder", "page-finder"]);

interface InvalidateArgs {
  subcommand: "invalidate";
  uuids: string[];
  type: string;
  yes: boolean;
  all: boolean;
  /** Invalidate rounds to send (1 s apart); default 1. */
  repeat: number;
}

interface PruneLocalArgs {
  subcommand: "prune-local";
  yes: boolean;
}

type CacheArgs = InvalidateArgs | PruneLocalArgs;

interface InvalidateData {
  action: "invalidate";
  env: string;
  type: string;
  scope: "all" | "uuids";
  uuidCount: number;
  uuids: string[];
  /** The first round's per-route results. */
  routes: RouteResult[];
  /** Rounds requested (`--repeat`). */
  repeat: number;
  /** Every round, with its per-route results. */
  rounds: CacheClearRound[];
  /** Rounds in which at least one route answered 2xx. */
  okRounds: number;
  /** Every round reached a route. */
  verified: boolean;
}

/** One stale-artifact candidate (or, once `--yes` runs, a removed one). */
export interface CacheItem {
  /** Relative to `~/.wi-impl/cache` (or `WI_IMPL_HOME`/cache). */
  path: string;
  bytes: number;
  ageMs: number;
}

export interface PruneCategorySummary {
  scanned: number;
  bytes: number;
  /** First `SAMPLE_LIMIT` items, path-sorted, for display. */
  sample: CacheItem[];
  /** Items beyond the sample. */
  truncated: number;
}

export interface PruneLocalData {
  action: "prune-local";
  cacheDir: string;
  dryRun: boolean;
  flatFiles: PruneCategorySummary;
  staleLocks: PruneCategorySummary;
  removed: { files: number; bytes: number };
  /** Namespaces skipped because their flat layout is by design (see `UNSCOPED_NAMESPACES`). */
  skippedNamespaces: string[];
}

type CacheData = InvalidateData | PruneLocalData;

/** `--repeat <n>`: a whole number from 1 to MAX_REPEAT (default 1). */
export function parseRepeat(value: string | undefined): number {
  if (value === undefined) return 1;
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_REPEAT) {
    throw new CliError(`--repeat must be a whole number from 1 to ${MAX_REPEAT}, got '${value}'.`, {
      code: "INVALID_ARGS",
      details: { repeat: value },
    });
  }
  return n;
}

/** One argument may hold several uuids (`"a b c"`, `a,b,c`: a quoted shell list). */
function parseUuids(rest: string[]): string[] {
  return rest.flatMap(u => u.split(/[\s,]+/)).filter(u => u.length > 0);
}

/**
 * Refuse anything that is not a uuid (32 hex chars, or the dashed 8-4-4-4-12 form): `invalidate` is the default
 * subcommand, so a mistyped subcommand (`wi-impl cache prune`) used to be POSTed
 * as the uuid "prune" and reported as a successful invalidation.
 */
export function assertCacheUuids(uuids: string[]): void {
  const bad = uuids.filter(u => !isEntityId(u));
  if (bad.length === 0) return;
  const known = ["invalidate", "prune-local"];
  const looksLikeSubcommand = bad.length === 1 && uuids.length === 1 && /^[a-z][a-z-]*$/.test(bad[0]!);
  throw new CliError(
    `Invalid cache UUID${bad.length === 1 ? "" : "s"}: ${bad.map(b => `'${b.slice(0, 60)}'`).join(", ")}. ` +
      `Expected 32 hex characters.` +
      (looksLikeSubcommand ? ` Subcommands: ${known.join(", ")}.` : ""),
    { code: "INVALID_UUID", details: { invalid: bad, subcommands: known } },
  );
}

/**
 * Request body. The server key is `uuids` (plural). An empty or absent `uuids` list
 * means "flush every entry of this type for the whole org" — callers must only build
 * that deliberately (scope "all").
 */
export function buildInvalidateBody(uuids: string[], type: string): { uuids: string[]; type: string } {
  return { uuids: [...uuids], type };
}

// ── prune-local: local filesystem cleanup, no network ──────────────────────

function listDirs(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

function statSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Every `.refresh` directory anywhere under `root` (legacy top-level, or the current per-env one). */
function findRefreshDirs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === ".refresh") out.push(p);
      else stack.push(p);
    }
  }
  return out;
}

/**
 * Flat `<namespace>/<key>.json` files left over from before caches became
 * env-scoped (current layout: `<namespace>/<env>/<key>.json`). Skips namespaces
 * that are flat by design (`UNSCOPED_NAMESPACES`).
 */
export function scanFlatCacheFiles(cacheDir: string, now = Date.now()): { items: CacheItem[]; skippedNamespaces: string[] } {
  const items: CacheItem[] = [];
  const skippedNamespaces: string[] = [];
  for (const ns of listDirs(cacheDir)) {
    if (UNSCOPED_NAMESPACES.has(ns)) {
      skippedNamespaces.push(ns);
      continue;
    }
    const nsDir = join(cacheDir, ns);
    let children: Dirent[];
    try {
      children = readdirSync(nsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of children) {
      if (!c.isFile() || !c.name.endsWith(".json")) continue;
      const p = join(nsDir, c.name);
      const st = statSafe(p);
      if (!st) continue;
      items.push({ path: relative(cacheDir, p), bytes: st.size, ageMs: Math.max(0, now - st.mtimeMs) });
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { items, skippedNamespaces: skippedNamespaces.sort() };
}

/** `.refresh/*.lock` files older than `maxAgeMs` (an active lock never gets this old). */
export function scanStaleLocks(cacheDir: string, maxAgeMs: number, now = Date.now()): CacheItem[] {
  const items: CacheItem[] = [];
  for (const refreshDir of findRefreshDirs(cacheDir)) {
    let children: Dirent[];
    try {
      children = readdirSync(refreshDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const c of children) {
      if (!c.isFile() || !c.name.endsWith(".lock")) continue;
      const p = join(refreshDir, c.name);
      const st = statSafe(p);
      if (!st) continue;
      const ageMs = Math.max(0, now - st.mtimeMs);
      if (ageMs > maxAgeMs) items.push({ path: relative(cacheDir, p), bytes: st.size, ageMs });
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}

function summarize(items: CacheItem[]): PruneCategorySummary {
  const bytes = items.reduce((sum, i) => sum + i.bytes, 0);
  return { scanned: items.length, bytes, sample: items.slice(0, SAMPLE_LIMIT), truncated: Math.max(0, items.length - SAMPLE_LIMIT) };
}

/**
 * Scan `cacheDir` for stale local artifacts and, when `yes` is true, delete them.
 * Pure and side-effect-free beyond the filesystem it is pointed at — takes
 * `cacheDir` explicitly (rather than reading `BELZ_CONFIG_DIR` itself) so tests
 * can run it against an isolated scratch directory. `onError` receives a message
 * for any file that failed to delete (best-effort: one failure does not abort
 * the rest).
 */
export function pruneLocalCache(
  cacheDir: string,
  options: { yes: boolean; now?: number; onError?: (message: string) => void } = { yes: false },
): PruneLocalData {
  const now = options.now ?? Date.now();
  const { items: flatItems, skippedNamespaces } = scanFlatCacheFiles(cacheDir, now);
  const lockItems = scanStaleLocks(cacheDir, STALE_LOCK_AGE_MS, now);

  let removedFiles = 0;
  let removedBytes = 0;
  if (options.yes) {
    for (const item of [...flatItems, ...lockItems]) {
      try {
        rmSync(join(cacheDir, item.path), { force: true });
        removedFiles += 1;
        removedBytes += item.bytes;
      } catch (e: any) {
        options.onError?.(`Failed to remove ${item.path}: ${e?.message ?? String(e)}`);
      }
    }
  }

  return {
    action: "prune-local",
    cacheDir,
    dryRun: !options.yes,
    flatFiles: summarize(flatItems),
    staleLocks: summarize(lockItems),
    removed: { files: options.yes ? removedFiles : 0, bytes: options.yes ? removedBytes : 0 },
    skippedNamespaces,
  };
}

async function executePruneLocal(args: PruneLocalArgs, context: CommandContext): Promise<CommandResult<PruneLocalData>> {
  const cacheDir = join(BELZ_CONFIG_DIR, "cache");
  const data = pruneLocalCache(cacheDir, { yes: args.yes, onError: msg => context.warn(msg) });
  return ok<PruneLocalData>(data);
}

function presentPruneLocal(data: PruneLocalData, ui: HumanPresenterHelpers): void {
  const totalScanned = data.flatFiles.scanned + data.staleLocks.scanned;
  if (totalScanned === 0) {
    ui.success("No stale local cache artifacts found.");
    return;
  }
  ui.section(data.dryRun ? "Dry run — pass --yes to delete" : "Removed");
  ui.table(
    ["Category", "Count", "Bytes"],
    [
      ["Flat legacy cache files", String(data.flatFiles.scanned), String(data.flatFiles.bytes)],
      ["Stale refresh locks (>10m)", String(data.staleLocks.scanned), String(data.staleLocks.bytes)],
    ],
  );
  const totalBytes = data.flatFiles.bytes + data.staleLocks.bytes;
  if (data.dryRun) {
    ui.info(`Would remove ${totalScanned} file(s), ${totalBytes} bytes. Pass --yes to delete.`);
  } else {
    ui.success(`Removed ${data.removed.files} file(s), ${data.removed.bytes} bytes.`);
  }
  if (data.skippedNamespaces.length > 0) {
    ui.info(`Skipped (flat by design, not env-scoped): ${data.skippedNamespaces.join(", ")}`);
  }
  const sample = [...data.flatFiles.sample, ...data.staleLocks.sample];
  if (sample.length > 0) {
    ui.section("Sample");
    for (const item of sample) ui.text(item.path);
    const truncated = data.flatFiles.truncated + data.staleLocks.truncated;
    if (truncated > 0) ui.text(`… and ${truncated} more`);
  }
}

// ── args ─────────────────────────────────────────────────────────────────

export const args = defineSubcommands(
  {
    invalidate: {
      positionals: [{ name: "uuids", variadic: true }],
      flags: {
        type: { type: "string", default: DEFAULT_TYPE },
        all: { type: "boolean" },
        repeat: { type: "string" },
        yes: { type: "boolean", alias: ["-y"] },
      },
    },
    "prune-local": {
      flags: {
        yes: { type: "boolean", alias: ["-y"] },
      },
    },
  },
  { command: "wi-impl cache", default: "invalidate" },
);

const command: CommandModule<CacheArgs, CacheData> = {
  /** Only `invalidate` writes remotely; `prune-local` only touches local files (see `writesLocal`). */
  writes: args => args.subcommand !== "prune-local",
  writesLocal: true,

  parseArgs(argv) {
    const parsed = args.parse(argv);
    if (parsed.subcommand === "prune-local") {
      return { subcommand: "prune-local", yes: parsed.flags.yes };
    }
    const { positionals, flags } = parsed;
    const { type, yes, all } = flags;
    const repeat = parseRepeat(flags.repeat);
    const uuids = parseUuids(positionals.uuids);
    if (all && uuids.length > 0) {
      throw new CliError("--all cannot be combined with UUIDs.", { code: "INVALID_ARGS" });
    }
    assertCacheUuids(uuids);
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

    return { subcommand: "invalidate", uuids, type, yes, all, repeat };
  },

  async execute(args, context) {
    if (args.subcommand === "prune-local") {
      return executePruneLocal(args, context);
    }

    // parseArgs already enforces this; re-check so a direct execute() call cannot flush the org.
    if (args.uuids.length === 0 && !(args.all && args.yes)) {
      throw new CliError("Refusing an invalidate with no UUIDs unless --all --yes is passed.", {
        code: "CACHE_CONFIRMATION_REQUIRED",
      });
    }
    assertCacheUuids(args.uuids);
    const scope: InvalidateData["scope"] = args.uuids.length === 0 ? "all" : "uuids";
    const envName = context.env.name;
    const body = buildInvalidateBody(args.uuids, args.type);

    const spin = lifecycle.spinner("Invalidating cache");
    spin.start(
      scope === "all"
        ? `Invalidating all '${args.type}' entries on ${envName} (${Config.cleanBaseUrl})…`
        : `Invalidating ${args.uuids.length} '${args.type}' entr${args.uuids.length === 1 ? "y" : "ies"} on ${envName}…`,
    );

    const repeat = args.repeat ?? 1;
    const clear = await clearServerCache(body.uuids, {
      type: body.type,
      repeat,
      all: scope === "all",
      onRound: (round, of) => {
        if (of > 1) spin.message(`Round ${round.round}/${of} ${round.ok ? "sent" : "failed"} on ${envName}…`);
      },
    });
    const routes = clear.rounds[0]?.routes ?? [];

    if (clear.okRounds === 0) {
      spin.error("Cache invalidate failed on every route.");
      throw new CliError(
        `Cache invalidate failed on all routes: ${routes.map(r => `${r.path} → ${r.status ?? r.error}`).join("; ")}`,
        { code: "CACHE_API_ERROR", details: { routes, rounds: clear.rounds } },
      );
    }
    for (const r of routes.filter(r => !r.ok)) {
      context.warn(`${r.path} did not succeed (${r.status ?? r.error}); another route did.`);
    }
    if (!clear.verified) {
      context.warn(
        `Only ${clear.okRounds} of ${repeat} invalidate rounds reached a route on ${envName}; ` +
          "some servers may still hold the old entries. Run it again.",
      );
    }
    spin.stop(repeat > 1 ? `Cache invalidate sent ${clear.okRounds}/${repeat} rounds.` : "Cache invalidate request complete.");

    return ok<InvalidateData>({
      action: "invalidate",
      env: envName,
      type: args.type,
      scope,
      uuidCount: args.uuids.length,
      uuids: args.uuids,
      routes,
      repeat,
      rounds: clear.rounds,
      okRounds: clear.okRounds,
      verified: clear.verified,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as CacheData;
    if (data.action === "prune-local") {
      presentPruneLocal(data, ui);
      return;
    }
    const target =
      data.scope === "all"
        ? `entire '${data.type}' cache`
        : `${data.uuidCount} '${data.type}' entr${data.uuidCount === 1 ? "y" : "ies"}`;
    const rounds = data.repeat > 1 ? ` (${data.okRounds}/${data.repeat} rounds reached a route)` : "";
    if (data.verified) ui.success(`Invalidated ${target} on ${data.env}${rounds}.`);
    else ui.warn(`Invalidated ${target} on ${data.env}${rounds}; some rounds failed.`);
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
