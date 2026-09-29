// AD method tracing — locate a method across every environment.
//
// The DEV version history is the canonical "spine": a totally-ordered list of
// content states. Each environment is a pointer into that spine, found by
// fingerprinting the env's latest-published version and matching it to a spine
// entry. This answers "which change of this method has reached which env" —
// the foundation of release collision/leak detection.
//
// AD chain UUIDs are stable across environments, so a single UUID resolves
// everywhere. Used by `belz ad trace` and `belz release matrix`.
//
// NOTE: traceMethod switches the global active env while it runs (restored in
// `finally`), so calls must not run concurrently.

import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, CliError, Config } from "@belzabar/core";
import { adApi } from "./api/index";
import type { MethodVersionFull } from "./api/v1";
import { fingerprintMethod, parseVersionBody } from "./fingerprint";
import { resolveMethodRef } from "./ids";

export interface TraceOptions {
  uuid: string;
  /** Env whose version history forms the spine. */
  spineEnv: string;
  /**
   * Envs to locate the method on (AD-25). Default: every configured env of
   * the spine env's project (`acme-*` for an `acme-dev` spine), never other projects.
   * The spine env is always included.
   */
  envs?: string[];
}

/** Default env set for a trace: the spine env's project family, spine first. */
/**
 * Published history versions are immutable, and each `historyGet` is a chain
 * execute: bodies are cached per env + methodVersionID (ADR-R14).
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

export interface SpineEntry {
  index: number;
  version: number;
  methodVersionID: string;
  isPublished: boolean;
  addedBy: number;
  addedWhen: string;
  stepCount: number;
  hash: string;
}

export interface EnvRow {
  env: string;
  ok: boolean;
  /** Latest published version number on this env (env-local; not comparable across envs). */
  version: number | null;
  changedAt: string | null;
  hash: string | null;
  /** Index into the spine, or -1 when the env content matches no spine entry. */
  spinePos: number;
  spineVersion: number | null;
  status: "latest" | "behind" | "ahead-or-diverged" | "missing" | "error";
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
    Config.setActiveEnv(args.spineEnv);
    const inputUuid = resolveMethodRef(args.uuid);
    const input = await adApi.fetchMethod(inputUuid, "v1");
    // The spine is the PUBLISHED timeline, and history.get without
    // includeDraft reads the published chain (F7): list the same chain.
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
    const versionList = (await adApi.historyListAll(uuid, { includeDraft: false }))
      .filter((v) => v.isPublished);
    versionList.sort((a, b) => a.methodVersion - b.methodVersion);

    const spine: SpineEntry[] = await mapLimit(versionList, 6, async (v) => {
      const full = await publishedVersionBody(args.spineEnv, v.methodVersionID, { category, methodName, version: v.methodVersion });
      const parsed = parseVersionBody(full);
      return {
        index: 0, // assigned below
        version: v.methodVersion,
        methodVersionID: v.methodVersionID,
        isPublished: v.isPublished,
        addedBy: v.addedBy,
        addedWhen: v.addedWhen,
        stepCount: parsed.parsedSteps.length,
        hash: fingerprintMethod(parsed),
      };
    });
    spine.forEach((s, i) => (s.index = i));

    if (spine.length === 0) {
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

    // ── 2. Fingerprint every environment's latest-published version. ──
    // Env rows go through the SAME history path as the spine (historyGet +
    // parseVersionBody). parseV1 and parseV2 populate the semantic fields
    // differently enough that mixing a live V1 response with a V2 history
    // spine yields false "diverged" — so both sides must use one path.
    // An env whose history service is unavailable is reported as `error`
    // rather than guessed at.
    const environments: EnvRow[] = [];
    for (const envName of allEnvs) {
      try {
        Config.setActiveEnv(envName);
        const list = await adApi.historyListAll(uuid, { includeDraft: false });
        const published = list
          .filter((v) => v.isPublished)
          .sort((a, b) => a.methodVersion - b.methodVersion);
        const head = published[published.length - 1] ?? null;

        if (!head) {
          environments.push({
            env: envName, ok: true, version: null, changedAt: null, hash: null,
            spinePos: -1, spineVersion: null, status: "missing",
            note: "no published version on this env",
          });
          continue;
        }

        const full = await publishedVersionBody(envName, head.methodVersionID, { category, methodName, version: head.methodVersion });
        const hash = fingerprintMethod(parseVersionBody(full));
        const positions = hashIndex.get(hash) ?? [];
        const spinePos = positions.length ? positions[positions.length - 1]! : -1;

        let status: EnvRow["status"];
        if (spinePos === -1) status = "ahead-or-diverged";
        else if (spinePos === lastIndex) status = "latest";
        else status = "behind";

        environments.push({
          env: envName, ok: true,
          version: head.methodVersion,
          changedAt: head.addedWhen,
          hash,
          spinePos,
          spineVersion: spinePos >= 0 ? spine[spinePos]!.version : null,
          status,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const missing = /404|not found/i.test(msg);
        environments.push({
          env: envName, ok: false, version: null, changedAt: null, hash: null,
          spinePos: -1, spineVersion: null,
          status: missing ? "missing" : "error",
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
