// After a build wrote the TARGET env: drop wi-impl's local copies of the ids
// there, and clear the target server's compiled AD cache for them.
//
// The server clear is repeated (TARGET_CACHE_ROUNDS rounds, 1 s apart): an env
// can run several servers behind one load balancer and one request reaches
// one of them. A single clear right after a migration left about half of the
// requests on the old chain. The result says how many rounds reached a route;
// it is never reported as done on one request.

import { Config } from "@belzabar/core";
import { CACHE_REPEAT_DELAY_MS, clearServerCache, invalidateEntityCache, type CacheClearRound } from "@belzabar/core/platform";
import type { TargetServerCache } from "./types";

/** Server-side clear rounds after a migration. */
export const TARGET_CACHE_ROUNDS = 5;

/** Pause between server rounds; tests set it to 0. */
export const targetCacheTiming = { delayMs: CACHE_REPEAT_DELAY_MS };

/** The command that repeats the clear by hand. */
export function cacheCommandHint(env: string, ids: readonly string[]): string {
  return `wi-impl cache --env ${env} --repeat ${TARGET_CACHE_ROUNDS} ${ids.join(" ")}`;
}

/**
 * Drop `env`'s local cache entries for `ids` and, for AD, clear the env's
 * server cache in repeated rounds. Never throws. The server clear is skipped
 * (with a reason) when `env` is not configured locally.
 */
export async function clearTargetCache(
  kind: "AD" | "PD",
  env: string,
  ids: readonly string[],
  opts: { rounds?: number; delayMs?: number; onRound?: (round: CacheClearRound, of: number) => void } = {},
): Promise<{ local: string[]; server?: TargetServerCache }> {
  const local = await invalidateEntityCache(kind, env, ids).catch(() => []);
  if (kind !== "AD" || ids.length === 0) return { local };
  if (!Config.getAllEnvs()[env]) {
    return { local, server: { env, skipped: `env '${env}' is not configured in ~/.wi-impl/config.json` } };
  }
  const restoreEnv = Config.captureActiveEnv();
  try {
    Config.setActiveEnv(env);
    const clear = await clearServerCache(ids, {
      type: "AUTOMATION",
      repeat: opts.rounds ?? TARGET_CACHE_ROUNDS,
      delayMs: opts.delayMs ?? targetCacheTiming.delayMs,
      onRound: opts.onRound,
    });
    return { local, server: { env, ...clear } };
  } catch (e) {
    return { local, server: { env, skipped: e instanceof Error ? e.message : String(e) } };
  } finally {
    restoreEnv();
  }
}
