// What an `ad test` / `ad run` really executes, said up front:
//   - ranVersion: the copy the uuid names (`PUBLISHED v5`, `DRAFT v6`). A uuid runs its OWN
//     body, so a published uuid runs the published copy even after `ad save` changed the draft.
//   - unpublishedDraftOf: a PUBLISHED uuid whose draft has different logic (fingerprints,
//     as `ad state` compares them).
//   - calleeDrafts: methods the steps call whose draft differs from their published copy. A
//     call step always runs the callee's PUBLISHED copy, whatever copy the caller is.
//   - asyncSteps: steps that start a call without waiting for it (it really runs).
// Every check is best effort: a read that fails gives no warning, never an error.

import { isObj, str } from "@belzabar/core";
import { adApi } from "./api/index";
import { fingerprintMethod } from "./fingerprint";
import type { HydratedMethod } from "./types/common";

export interface RanVersion {
  uuid: string;
  state: HydratedMethod["state"];
  version: number | null;
  /** `PUBLISHED v5` */
  label: string;
}

export function ranVersionOf(m: HydratedMethod): RanVersion {
  const version = typeof m.version === "number" ? m.version : null;
  return { uuid: m.uuid, state: m.state, version, label: `${m.state}${version != null ? ` v${version}` : ""}` };
}

interface DraftDrift {
  publishedUuid: string;
  draftUuid: string;
  draftVersion: number | null;
}

/** Both sides on V2 (as `ad state`): null when in sync or unreadable. */
async function driftBetween(publishedUuid: string, draftUuid: string): Promise<DraftDrift | null> {
  try {
    const [pub, draft] = await Promise.all([adApi.fetchMethod(publishedUuid, "v2"), adApi.fetchMethod(draftUuid, "v2")]);
    if (fingerprintMethod(pub) === fingerprintMethod(draft)) return null;
    return { publishedUuid, draftUuid, draftVersion: typeof draft.version === "number" ? draft.version : null };
  } catch {
    return null;
  }
}

/** A PUBLISHED method whose draft has unpublished changes: the draft; else null. */
export async function unpublishedDraftOf(m: HydratedMethod): Promise<DraftDrift | null> {
  const ref = (m.referenceId ?? "").trim().toLowerCase();
  if (m.state !== "PUBLISHED" || !ref) return null;
  return driftBetween(m.uuid, ref);
}

interface CalleeDraft extends DraftDrift {
  /** Steps (orderIndex) that call it. */
  steps: number[];
  category: string;
  method: string;
}

/** The published chain uuid of `category.method` (child-info), or null for a system service. */
async function publishedChainOf(category: string, method: string): Promise<string | null> {
  try {
    const info = await adApi.fetchChildMethodInfo(category, method);
    if (!isObj(info)) return null;
    return str(info.serviceChainUID)?.trim().toLowerCase() ?? str(info.methodUUID)?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Methods the steps call whose draft differs from the published copy the call runs. */
export async function calleeDrafts(m: HydratedMethod): Promise<CalleeDraft[]> {
  const byCallee = new Map<string, { category: string; method: string; steps: number[] }>();
  for (const s of m.parsedSteps) {
    if (s.kind !== "EXISTING_SERVICE" || !s.serviceName || !s.methodName) continue;
    const key = `${s.serviceName}\u0000${s.methodName}`;
    const hit = byCallee.get(key) ?? { category: s.serviceName, method: s.methodName, steps: [] };
    hit.steps.push(s.orderIndex);
    byCallee.set(key, hit);
  }
  const found = await Promise.all(
    [...byCallee.values()].map(async (c) => {
      const pubUuid = await publishedChainOf(c.category, c.method);
      if (!pubUuid) return null;
      let pub: HydratedMethod;
      try {
        pub = await adApi.fetchMethod(pubUuid, "v2");
      } catch {
        return null;
      }
      const ref = (pub.referenceId ?? "").trim().toLowerCase();
      if (pub.state !== "PUBLISHED" || !ref) return null;
      const drift = await driftBetween(pubUuid, ref);
      return drift ? { ...drift, ...c } : null;
    }),
  );
  return found.filter((x): x is CalleeDraft => x !== null);
}

/** Steps (orderIndex) that run async: started, not awaited. */
export function asyncSteps(m: HydratedMethod): number[] {
  return m.parsedSteps.filter((s) => s.runAsync).map((s) => s.orderIndex);
}

/** The warning lines for a run of `m` (what ran, drafts it does not run, async steps). */
export function runWarnings(m: HydratedMethod, own: DraftDrift | null, callees: CalleeDraft[], opts: { async?: boolean } = {}): string[] {
  const out: string[] = [];
  if (own) {
    out.push(
      `${m.uuid} is PUBLISHED v${m.version}: this runs the published copy, not its draft ${own.draftUuid}` +
        `${own.draftVersion != null ? ` (v${own.draftVersion})` : ""}, which has unpublished changes. Pass the draft uuid to run them.`,
    );
  }
  for (const c of callees) {
    out.push(
      `Step ${c.steps.join(", ")} calls ${c.category}.${c.method}, whose draft ${c.draftUuid} has unpublished changes: ` +
        `a call always runs the callee's PUBLISHED copy (${c.publishedUuid}), so those changes do not run here.`,
    );
  }
  const asyncs = opts.async ? asyncSteps(m) : [];
  if (asyncs.length) {
    out.push(
      `Step ${asyncs.join(", ")} ${asyncs.length > 1 ? "run" : "runs"} async: the call is started and really runs (with its side effects), ` +
        "but is not awaited; the trace shows it as 'dispatched (async)'.",
    );
  }
  return out;
}
