// The fresh V2 read behind `show --compact` / `--story` and `outputs`, so the
// views agree on names (V2 keys = what save ops and create specs take).

import { CliError, currentCacheEnv } from "@belzabar/core";
import { adApi } from "./api/index";
import * as v2 from "./api/v2";
import { isMethodGone } from "./method-finder";
import type { HydratedMethod } from "./types/common";

/**
 * V2, fresh (never the V1-shaped cache). Falls back to the V1 parse only when
 * the V2 route refuses the method (some old bodies fail the server's V2
 * conversion); an unknown uuid still fails.
 */
export async function fetchViewMethod(uuid: string, warn: (m: string) => void): Promise<HydratedMethod> {
  try {
    return await adApi.fetchMethod(uuid, "v2");
  } catch (err) {
    if (err instanceof CliError && err.code === "METHOD_NOT_FOUND") throw err;
    warn(`V2 read failed (${(err as Error).message}); showing the V1 parse, whose input names are UI labels, not save keys.`);
    return adApi.fetchMethod(uuid, "v1");
  }
}

function deletedError(uuid: string): CliError {
  return new CliError(`Method ${uuid} is deleted (soft-deleted: the V1 route still serves the record, V2 does not).`, {
    code: "METHOD_NOT_FOUND",
    details: { uuid, deleted: true },
  });
}

/**
 * A fetch for `show` / `fetch`. V1 keeps serving soft-deleted methods (their
 * V1 fields do not mark deletion), so a fresh V1 read runs a V2 read beside it:
 * METHOD_NOT_FOUND there means deleted → METHOD_NOT_FOUND {deleted: true},
 * the same answer V2 and `show --compact` give. Other V2 failures (old bodies
 * the server cannot convert) are ignored.
 */
export async function fetchMethodChecked(uuid: string, version: "v1" | "v2"): Promise<HydratedMethod> {
  if (version === "v2") return adApi.fetchMethod(uuid, "v2");
  const [method, probe] = await Promise.all([
    adApi.fetchMethod(uuid, "v1"),
    v2.fetchRawMethod(uuid).then(
      () => null,
      (e: unknown) => e,
    ),
  ]);
  if (probe instanceof CliError && probe.code === "METHOD_NOT_FOUND") throw deletedError(uuid);
  return method;
}

/** A cached read of a uuid this env already saw deleted (a gone mark) is refused the same way. */
export async function assertNotKnownDeleted(uuid: string): Promise<void> {
  if (await isMethodGone(currentCacheEnv(), uuid)) throw deletedError(uuid);
}
