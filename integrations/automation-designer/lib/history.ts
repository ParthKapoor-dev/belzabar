// Method history helpers shared by `ad history` and `ad diff`.
//
// history.get is addressed by category + method name, and the draft and the
// published chain share both. `includeDraft: true` returns the DRAFT chain's
// version N, otherwise the PUBLISHED chain's; `listAll` lists by uuid. The two
// chains keep independent version counters, so version N must be read from
// the side the uuid names.

import { CliError } from "@belzabar/core";
import { adApi, type MethodVersionFull } from "./api/index";
import * as v1 from "./api/v1";
import type { HydratedMethod } from "./types/common";

/**
 * When the method was last saved: the V1 chain's `updatedOn` (else `createdOn` for a
 * never-updated method), as ISO-8601 UTC. The V2 GET carries no update stamp. Best effort:
 * null when the read fails or the stamp is missing.
 */
export async function lastUpdatedOf(uuid: string): Promise<string | null> {
  try {
    const raw = await v1.fetchRawMethod(uuid);
    const ms = Number(raw.updatedOn ?? raw.createdOn);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

/** Which chain's history a uuid names. */
export type HistorySide = "DRAFT" | "PUBLISHED";

export function sideOf(m: HydratedMethod): HistorySide {
  return m.state === "PUBLISHED" ? "PUBLISHED" : "DRAFT";
}

function sameUuid(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Fetch version N of *this* chain's history: the side follows the method's
 * state, and the returned `methodID` is checked against its uuid (falling
 * back to the other side once when they disagree).
 */
export async function getVersionOf(
  method: HydratedMethod,
  category: string,
  version: number,
): Promise<MethodVersionFull> {
  const order = sideOf(method) === "DRAFT" ? [true, false] : [false, true];
  let last: MethodVersionFull | undefined;
  for (const includeDraft of order) {
    const full = await adApi.historyGet({ category, methodName: method.name, version, includeDraft });
    if (!full.methodID || sameUuid(full.methodID, method.uuid)) return full;
    last = full;
  }
  throw new CliError(
    `History version ${version} of "${method.name}" did not resolve to ${method.uuid} (got methodID ${last?.methodID}).`,
    { code: "HISTORY_SIDE_MISMATCH", details: { uuid: method.uuid, version, methodID: last?.methodID } },
  );
}
