// AD method tracing — locate a method across every environment.
//
// The DEV version history is the canonical "spine": a totally-ordered list of
// content states. Each environment is a pointer into that spine, found by
// fingerprinting the env's latest-published version and matching it to a spine
// entry. This answers "which change of this method has reached which env" —
// the foundation of release collision/leak detection.
//
// AD chain UUIDs are stable across environments, so a single UUID resolves
// everywhere. Used by `wi-impl ad trace` and `wi-impl release matrix`.
//
// NOTE: traceMethod switches the global active env while it runs (restored in
// `finally`), so calls must not run concurrently.

import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, CliError, Config } from "@belzabar/core";
import { adApi } from "./api/index";
import type { MethodVersionFull } from "./api/v1";
import { fingerprintMethod, parseVersionBody } from "./fingerprint";
import { historyTimeIso, lastUpdatedOf } from "./history";
import type { HydratedMethod } from "./types/common";
import { resolveMethodRef } from "@belzabar/core/platform";

interface TraceOptions {
  uuid: string;
  /** Env whose version history forms the spine. */
  spineEnv: string;
  /**
   * Envs to locate the method on. Default: every configured env of
   * the spine env's project (`acme-*` for an `acme-dev` spine), never other projects.
   * The spine env is always included.
   */
  envs?: string[];
}

/** Default env set for a trace: the spine env's project family, spine first. */
/**
 * Published history versions are immutable, and each `historyGet` is a chain
 * execute: bodies are cached per env + methodVersionID.
 */
const historyBodyCache = new Cache<MethodVersionFull>({
  dir: join(BELZ_CONFIG_DIR, "cache", "history-versions"),
  ttlMs: 30 * 24 * 60 * 60 * 1000,
});

async function publishedVersionBody(
  env: string,
  methodVersionID: string,
  opts: { category: string; methodName: string; version: number },
): Promise<MethodVersionFull> {
  const id = methodVersionID.trim();
  if (id) {
    const hit = await historyBodyCache.load(id, env);
    if (hit) return hit;
  }
  const full = await adApi.historyGet({ ...opts, includeDraft: false });
  if (id && full) await historyBodyCache.save(id, full, env);
  return full;
}

export function traceEnvFamily(spineEnv: string, all: Record<string, { project: string }> = Config.getAllEnvs()): string[] {
  const project = all[spineEnv]?.project;
  const family = Object.keys(all).filter((n) => n !== spineEnv && all[n]!.project === project);
  return [spineEnv, ...family];
}

interface SpineEntry {
  index: number;
  version: number;
  methodVersionID: string;
  isPublished: boolean;
  addedBy: number;
  addedWhen: string;
  stepCount: number;
  hash: string;
}

interface EnvRow {
  env: string;
  ok: boolean;
  /** Latest published version number on this env (env-local; not comparable across envs). */
  version: number | null;
  changedAt: string | null;
  hash: string | null;
  /** Index into the spine, or -1 when the env content matches no spine entry. */
  spinePos: number;
  spineVersion: number | null;
  /**
   * unreachable: the env (or its history service) did not answer; unpositioned: found,
   * but the spine env is unreachable; present-no-history: published, but the platform
   * has no history for it on this env (its live body matched no spine entry).
   */
  status: "latest" | "behind" | "ahead-or-diverged" | "missing" | "error" | "unreachable" | "unpositioned" | "present-no-history";
  note?: string;
}

export interface TraceData {
  /** The PUBLISHED uuid that was traced (a draft uuid is mapped to its published referenceId). */
  uuid: string;
  /** The uuid the caller passed. */
  inputUuid: string;
  /** Envs located, in order. */
  envs: string[];
  name: string;
  category: string;
  spineEnv: string;
  spine: SpineEntry[];
  environments: EnvRow[];
  warnings: string[];
}

// Run async jobs with a concurrency cap so a long history doesn't open dozens
// of sockets at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The env did not answer: a timeout, a network failure or a 5xx (e.g. a stopped server's 503). */
function isUnreachable(e: unknown): boolean {
  if (!(e instanceof CliError)) return !(e instanceof Error) || /fetch|network|ECONN|socket|timed out/i.test(e.message);
  const status = (e.details as { status?: unknown } | undefined)?.status;
  return ["HTTP_TIMEOUT", "HTTP_NETWORK_ERROR", "NETWORK_ERROR", "ENV_UNAVAILABLE"].includes(e.code) || (typeof status === "number" && status >= 500);
}

function errorText(e: unknown): string {
  return e instanceof CliError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

/**
 * An env whose history lists no published version: read the method itself. A published
 * method there is present (its history is just empty), placed on the spine by its live
 * V2 body when that matches; METHOD_NOT_FOUND is really missing.
 */
async function rowWithoutHistory(
  env: string,
  uuid: string,
  place: (hash: string) => Pick<EnvRow, "spinePos" | "spineVersion" | "status">,
): Promise<EnvRow> {
  let live: HydratedMethod;
  let v1Only = false;
  try {
    live = await adApi.fetchMethod(uuid, "v2");
  } catch (e) {
    if (e instanceof CliError && e.code === "METHOD_NOT_FOUND") {
      return { env, ok: true, version: null, changedAt: null, hash: null, spinePos: -1, spineVersion: null, status: "missing", note: "not on this env" };
    }
    if (isUnreachable(e)) throw e;
    // Some old bodies fail the server's V2 conversion (400): V1 still says whether it is
    // published, but its fingerprint is not comparable with the spine's.
    live = await adApi.fetchMethod(uuid, "v1");
    v1Only = true;
  }
  if (live.state !== "PUBLISHED") {
    return { env, ok: true, version: null, changedAt: null, hash: null, spinePos: -1, spineVersion: null, status: "missing", note: "no published version on this env" };
  }
  const hash = v1Only ? null : fingerprintMethod(live);
  const placed = hash ? place(hash) : { spinePos: -1, spineVersion: null, status: "present-no-history" as const };
  const status = placed.status === "ahead-or-diverged" ? "present-no-history" : placed.status;
  return {
    env,
    ok: true,
    version: typeof live.version === "number" ? live.version : null,
    changedAt: await lastUpdatedOf(uuid),
    hash,
    ...placed,
    status,
    note:
      status === "present-no-history"
        ? "published, but the platform has no history for it on this env; its position is unknown"
        : "published, but the platform has no history for it on this env (placed by its current body)",
  };
}

export async function traceMethod(args: TraceOptions): Promise<TraceData> {
  const configured = Config.getAllEnvs();
  const allEnvNames = Object.keys(configured);
  if (!allEnvNames.includes(args.spineEnv)) {
    throw new CliError(`Unknown spine env '${args.spineEnv}'. Available: ${allEnvNames.join(", ")}`, {
      code: "UNKNOWN_ENV",
    });
  }
  const unknown = (args.envs ?? []).filter((e) => !allEnvNames.includes(e));
  if (unknown.length > 0) {
    throw new CliError(`Unknown env(s) ${unknown.join(", ")}. Available: ${allEnvNames.join(", ")}`, {
      code: "UNKNOWN_ENV",
    });
  }
  const allEnvs = args.envs && args.envs.length > 0
    ? [args.spineEnv, ...args.envs.filter((e) => e !== args.spineEnv)]
    : traceEnvFamily(args.spineEnv, configured);

  const restoreEnv = Config.captureActiveEnv();
  const warnings: string[] = [];

  try {
    // ── 1. Build the spine from the dev (spineEnv) version history. ──
    // A spine env that is down does not hide the other envs (D19): it is
    // reported `unreachable`, and the method is identified on the next env.
    const inputUuid = resolveMethodRef(args.uuid);
    let spineDown: string | null = null;
    let input: HydratedMethod | null = null;
    let lastError: unknown;
    for (const envName of allEnvs) {
      Config.setActiveEnv(envName);
      try {
        input = await adApi.fetchMethod(inputUuid, "v1");
        break;
      } catch (e) {
        if (envName === args.spineEnv) {
          if (!isUnreachable(e)) throw e;
          spineDown = errorText(e);
          warnings.push(`The spine env ${args.spineEnv} is unreachable (${spineDown}); the other envs are located without a spine position.`);
        }
        lastError = e;
      }
    }
    if (!input) throw lastError;
    // The spine is the PUBLISHED timeline, and history.get without
    // includeDraft reads the published chain: list the same chain.
    let uuid = inputUuid;
    if (input.state === "DRAFT") {
      const ref = (input.referenceId ?? "").trim();
      if (ref) {
        uuid = resolveMethodRef(ref);
        warnings.push(`${args.uuid} is a DRAFT; tracing its published chain ${ref}.`);
      } else {
        warnings.push(`${args.uuid} is a DRAFT that was never published — there is nothing to trace.`);
      }
    }
    const current = uuid === inputUuid ? input : await adApi.fetchMethod(uuid, "v1");
    const category = current.category?.name ?? "";
    const methodName = current.name;

    // Published timeline only — drafts are dev-only in-progress edits, never
    // promotable. includeDraft must match between spine and env rows below:
    // the flag changes the body historyGet returns for a given version.
    let spine: SpineEntry[] = [];
    if (!spineDown) {
      Config.setActiveEnv(args.spineEnv);
      try {
        const versionList = (await adApi.historyListAll(uuid, { includeDraft: false }))
          .filter((v) => v.isPublished);
        versionList.sort((a, b) => a.methodVersion - b.methodVersion);

        spine = await mapLimit(versionList, 6, async (v) => {
          const full = await publishedVersionBody(args.spineEnv, v.methodVersionID, { category, methodName, version: v.methodVersion });
          const parsed = parseVersionBody(full);
          return {
            index: 0, // assigned below
            version: v.methodVersion,
            methodVersionID: v.methodVersionID,
            isPublished: v.isPublished,
            addedBy: v.addedBy,
            addedWhen: historyTimeIso(v.addedWhen), // ISO UTC (the platform text has no zone)
            stepCount: parsed.parsedSteps.length,
            hash: fingerprintMethod(parsed),
          };
        });
      } catch (e) {
        if (!isUnreachable(e)) throw e;
        spineDown = errorText(e);
        warnings.push(`The spine env ${args.spineEnv}'s history is unreachable (${spineDown}); the other envs are located without a spine position.`);
      }
    }
    spine.forEach((s, i) => (s.index = i));

    if (spine.length === 0 && !spineDown) {
      warnings.push(`No version history on ${args.spineEnv} — cannot build a spine; environment positions are unknown.`);
    }

    // hash → spine indices (a hash can recur if a change was reverted).
    const hashIndex = new Map<string, number[]>();
    for (const s of spine) {
      const arr = hashIndex.get(s.hash) ?? [];
      arr.push(s.index);
      hashIndex.set(s.hash, arr);
    }
    const lastIndex = spine.length - 1;
    const place = (hash: string): Pick<EnvRow, "spinePos" | "spineVersion" | "status"> => {
      if (spineDown) return { spinePos: -1, spineVersion: null, status: "unpositioned" };
      const positions = hashIndex.get(hash) ?? [];
      const spinePos = positions.length ? positions[positions.length - 1]! : -1;
      return {
        spinePos,
        spineVersion: spinePos >= 0 ? spine[spinePos]!.version : null,
        status: spinePos === -1 ? "ahead-or-diverged" : spinePos === lastIndex ? "latest" : "behind",
      };
    };

    // ── 2. Fingerprint every environment's latest-published version. ──
    // Env rows go through the SAME history path as the spine (historyGet +
    // parseVersionBody). parseV1 and parseV2 populate the semantic fields
    // differently enough that mixing a live V1 response with a V2 history
    // spine yields false "diverged" — so both sides must use one path.
    // An env with no published history is checked on the method itself: the
    // platform's history can be empty for a published method (D19).
    const environments: EnvRow[] = [];
    for (const envName of allEnvs) {
      if (envName === args.spineEnv && spineDown) {
        environments.push({
          env: envName, ok: false, version: null, changedAt: null, hash: null,
          spinePos: -1, spineVersion: null, status: "unreachable", note: spineDown,
        });
        continue;
      }
      try {
        Config.setActiveEnv(envName);
        const list = await adApi.historyListAll(uuid, { includeDraft: false });
        const published = list
          .filter((v) => v.isPublished)
          .sort((a, b) => a.methodVersion - b.methodVersion);
        const head = published[published.length - 1] ?? null;

        if (!head) {
          environments.push(await rowWithoutHistory(envName, uuid, place));
          continue;
        }

        const full = await publishedVersionBody(envName, head.methodVersionID, { category, methodName, version: head.methodVersion });
        const hash = fingerprintMethod(parseVersionBody(full));
        const placed = place(hash);
        environments.push({
          env: envName, ok: true,
          version: head.methodVersion,
          changedAt: historyTimeIso(head.addedWhen),
          hash,
          ...placed,
          ...(placed.status === "unpositioned" ? { note: "spine env unreachable: position unknown" } : {}),
        });
      } catch (e) {
        const msg = errorText(e);
        const missing = (e instanceof CliError && e.code === "METHOD_NOT_FOUND") || /404|not found/i.test(msg);
        environments.push({
          env: envName, ok: false, version: null, changedAt: null, hash: null,
          spinePos: -1, spineVersion: null,
          status: missing ? "missing" : isUnreachable(e) ? "unreachable" : "error",
          note: msg,
        });
      }
    }

    // Sanity: the spine env's own row should land on the spine.
    const spineRow = environments.find((r) => r.env === args.spineEnv);
    if (spineRow && spineRow.ok && spineRow.spinePos === -1 && spine.length > 0) {
      warnings.push(
        `The spine env (${args.spineEnv}) did not match its own history — fingerprinting may be inconsistent for this method.`,
      );
    }

    return {
      uuid,
      inputUuid: args.uuid,
      envs: allEnvs,
      name: methodName,
      category,
      spineEnv: args.spineEnv,
      spine,
      environments,
      warnings,
    };
  } finally {
    restoreEnv();
  }
}
