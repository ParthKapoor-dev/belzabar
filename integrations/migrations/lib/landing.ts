// After a migration went to background mode (the service answered HTTP 206,
// the script ended "unexpected status: None" and Jenkins reported FAILURE),
// the build says nothing true about the ids: they may land minutes later, or
// never. So read each id's published version on the source once, then poll
// the target until every id carries the same version or the wait runs out.
//
// AD methods only: a migration keeps the method uuid, and the V1 chain body
// carries `version`.

import { CliError, Config, sleep } from "@belzabar/core";
import { fetchRawChain } from "@belzabar/core/platform";
import type { BackgroundCheck, LandingRow } from "./types";

/** Poll interval and total wait; tests shorten them. */
export const landingTiming = { intervalMs: 15_000, timeoutMs: 5 * 60_000 };

interface ChainVersion {
  name?: string;
  version?: number;
}

async function readVersion(uuid: string, env: string): Promise<ChainVersion | null> {
  const got = await fetchRawChain<Record<string, unknown>>(uuid, {
    onError: (res) => new CliError(`HTTP ${res.status} reading ${uuid} on '${env}'`, { code: "MIGRATE_LANDING_READ_FAILED" }),
  });
  if (!got.found) return null;
  const body = got.body;
  return {
    name: typeof body.name === "string" ? body.name : undefined,
    version: typeof body.version === "number" ? body.version : undefined,
  };
}

/** Read `ids` on `env` (switching the active env, restored after). Errors become per-id strings. */
async function readAll(ids: readonly string[], env: string): Promise<Map<string, ChainVersion | null | Error>> {
  const out = new Map<string, ChainVersion | null | Error>();
  const restore = Config.captureActiveEnv();
  try {
    Config.setActiveEnv(env);
    for (const id of ids) {
      try {
        out.set(id, await readVersion(id, env));
      } catch (e) {
        out.set(id, e instanceof Error ? e : new Error(String(e)));
      }
    }
  } finally {
    restore();
  }
  return out;
}

/**
 * Poll `targetEnv` until each id's version equals its version on `sourceEnv`
 * (or `landingTiming.timeoutMs` passes). Never throws; an env that is unknown
 * or not configured gives `skipped`.
 */
export async function checkLanding(
  ids: readonly string[],
  sourceEnv: string | undefined,
  targetEnv: string | undefined,
  opts: { onPoll?: (landed: number, total: number, waitedMs: number) => void } = {},
): Promise<BackgroundCheck> {
  const base = { sourceEnv, targetEnv, landed: [] as string[], notLanded: [...ids], rows: [] as LandingRow[], waitedMs: 0 };
  const envs = Config.getAllEnvs();
  if (!sourceEnv || !targetEnv) {
    return { ...base, skipped: "the profile's source/target envs are unknown (map them in jenkins.profileEnvs, or pass --source-env and --target-env)" };
  }
  const missing = [sourceEnv, targetEnv].filter((e) => !envs[e]);
  if (missing.length > 0) return { ...base, skipped: `env ${missing.map((e) => `'${e}'`).join(" and ")} not configured in ~/.wi-impl/config.json` };

  const source = await readAll(ids, sourceEnv);
  const rows = new Map<string, LandingRow>();
  for (const id of ids) {
    const s = source.get(id);
    if (s instanceof Error) rows.set(id, { id, landed: false, error: `source: ${s.message}` });
    else if (!s) rows.set(id, { id, landed: false, error: `not found on ${sourceEnv}` });
    else rows.set(id, { id, name: s.name, sourceVersion: s.version, landed: false });
  }

  const started = Date.now();
  while (true) {
    const pending = ids.filter((id) => { const r = rows.get(id)!; return !r.landed && r.sourceVersion !== undefined; });
    if (pending.length === 0) break;
    const target = await readAll(pending, targetEnv);
    for (const id of pending) {
      const row = rows.get(id)!;
      const t = target.get(id);
      if (t instanceof Error) row.error = `target: ${t.message}`;
      else {
        delete row.error;
        row.targetVersion = t?.version;
        row.landed = !!t && t.version === row.sourceVersion;
      }
    }
    const waited = Date.now() - started;
    const landedCount = [...rows.values()].filter((r) => r.landed).length;
    opts.onPoll?.(landedCount, ids.length, waited);
    if (landedCount === ids.length || waited + landingTiming.intervalMs > landingTiming.timeoutMs) break;
    await sleep(landingTiming.intervalMs);
  }

  const all = ids.map((id) => rows.get(id)!);
  return {
    ...base,
    landed: all.filter((r) => r.landed).map((r) => r.id),
    notLanded: all.filter((r) => !r.landed).map((r) => r.id),
    rows: all,
    waitedMs: Date.now() - started,
  };
}
