// What `ad publish` changes besides the method body, read before and after
// the publish so the result can say it.
//
//   - Test suite (A9). Publishing copies the draft's suite over the published
//     one (live, a dev env): the published suite and every case get new ids,
//     and a case that only the published copy had is deleted. Read both suites
//     before (to warn about published-only cases) and the published one after
//     (old → new ids, cases removed).
//   - Removed inputs (C5). The platform drops an input the method no longer
//     has from every step that calls it, in drafts and published copies alike,
//     so a published caller silently stops passing it. List the caller steps
//     that pass one of the removed inputs.

import { isObj, str } from "@belzabar/core";
import { fetchRawMethod } from "./api/v2";
import { findAdCallers, resolveCallTarget, stepCallsTarget, stepRefsOf } from "./callers";
import { loadDirtyMethods, loadOrBuildMethodFinderIndex, METHOD_FINDER_SCHEMA } from "./method-finder";
import { fetchSuite } from "./test-cases/suite";

// ── test suite ────────────────────────────────────────────────────────────

interface SuiteCaseRef {
  id: string;
  name: string;
}

export interface SuitesBeforePublish {
  draftSuiteId: string | null;
  draftCases: SuiteCaseRef[];
  publishedSuiteId: string | null;
  publishedCases: SuiteCaseRef[];
  /** Cases the published suite has and the draft's does not: the publish deletes them. */
  publishedOnly: SuiteCaseRef[];
}

export interface PublishedSuiteReport {
  /** The published suite id before → after (a publish replaces the suite: the id changes). */
  previousSuiteId: string | null;
  suiteId: string | null;
  /** Each draft case and the id of its copy on the published method; `previousId`: the published case of that name before (that id no longer exists). */
  copied: Array<{ name: string; draftId: string; publishedId: string | null; previousId?: string }>;
  /** Cases the published suite had before that it no longer has. */
  removed: SuiteCaseRef[];
}

const refs = (cases: Array<{ id: string; file: { name: string } }>): SuiteCaseRef[] => cases.map((c) => ({ id: c.id, name: c.file.name }));

export async function readSuitesBeforePublish(draftUuid: string, publishedUuid: string | undefined): Promise<SuitesBeforePublish> {
  const draft = await fetchSuite(draftUuid);
  const published = publishedUuid ? await fetchSuite(publishedUuid) : { testSuiteId: null, cases: [] };
  const draftCases = refs(draft.cases);
  const publishedCases = refs(published.cases);
  const draftNames = new Set(draftCases.map((c) => c.name));
  return {
    draftSuiteId: draft.testSuiteId,
    draftCases,
    publishedSuiteId: published.testSuiteId,
    publishedCases,
    publishedOnly: publishedCases.filter((c) => !draftNames.has(c.name)),
  };
}

export async function reportPublishedSuite(before: SuitesBeforePublish, publishedUuid: string): Promise<PublishedSuiteReport> {
  const after = await fetchSuite(publishedUuid);
  const afterCases = refs(after.cases);
  const afterByName = new Map(afterCases.map((c) => [c.name, c.id]));
  const previousByName = new Map(before.publishedCases.map((c) => [c.name, c.id]));
  return {
    previousSuiteId: before.publishedSuiteId,
    suiteId: after.testSuiteId,
    copied: before.draftCases.map((c) => {
      const previousId = previousByName.get(c.name);
      return { name: c.name, draftId: c.id, publishedId: afterByName.get(c.name) ?? null, ...(previousId ? { previousId } : {}) };
    }),
    removed: before.publishedCases.filter((c) => !afterByName.has(c.name)),
  };
}

// ── removed inputs ────────────────────────────────────────────────────────

const inputKeys = (body: unknown): string[] =>
  (isObj(body) && Array.isArray(body.inputs) ? body.inputs : []).map((i) => (isObj(i) ? str(i.key) : undefined)).filter((k): k is string => !!k);

/** Input keys the published copy has and the draft does not. */
export function removedInputs(draft: unknown, published: unknown): string[] {
  const kept = new Set(inputKeys(draft));
  return inputKeys(published).filter((k) => !kept.has(k));
}

interface RemovedInputCaller {
  name: string;
  category: string;
  /** DRAFT or PUBLISHED: a published caller changes behaviour as soon as this publish lands. */
  state: string;
  uuid: string;
  /** 1-based step number in the caller. */
  step: number;
  /** The removed inputs this step passes a value to. */
  inputs: string[];
}

export interface RemovedInputCallers {
  callers: RemovedInputCaller[];
  /** Methods in other categories the cached index cannot resolve (`ad callers --all` reads them). */
  unscannedMethods: number;
}

/**
 * Caller steps (drafts and published copies) that pass one of `removed` to
 * the method. Uses `ad callers`' cached index (built if missing) with the
 * method's own category resolved deeply.
 */
export async function findRemovedInputCallers(draftUuid: string, removed: string[]): Promise<RemovedInputCallers> {
  const target = await resolveCallTarget(draftUuid);
  const { index } = await loadOrBuildMethodFinderIndex({ refresh: false, minSchema: METHOD_FINDER_SCHEMA });
  const dirty = await loadDirtyMethods(index);
  const deep = new Set([target.category].filter(Boolean).map((c) => c.toLowerCase()));
  const found = await findAdCallers(index, target, { deep, dirty });
  const gone = new Set(removed);
  const callers: RemovedInputCaller[] = [];
  for (const c of found.callers) {
    const body = await fetchRawMethod(c.uuid);
    for (const s of stepRefsOf(body)) {
      if (!stepCallsTarget(s, target)) continue;
      const inputs = [...new Set((s.inputs ?? []).map((k) => k.split(".")[0]!).filter((k) => gone.has(k)))];
      if (inputs.length) callers.push({ name: c.name, category: c.category, state: c.state, uuid: c.uuid, step: s.i, inputs });
    }
  }
  return { callers, unscannedMethods: found.coverage.unscannedMethods };
}
