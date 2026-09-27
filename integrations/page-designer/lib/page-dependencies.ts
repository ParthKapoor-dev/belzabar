// Translation-phrase validation built on the page-dependencies API.
//
// GET /rest/api/pagedesigner/pages/page-dependencies returns a dependency
// graph whose `dependencyJSON` carries one `<pubId>__translated_phrases` array
// per entity (the queried entity plus each dependency). Two rules matter for a
// post-release check:
//   1. every phrase entry's `.key` is a well-formed `page.<id>` / `symbol.<id>`
//   2. the queried (main) entity's phrase keys embed that entity's draft id
// Style / font / image components legitimately carry NO `__translated_phrases`
// arrays — that is N/A, not a failure (the original ad-hoc script wrongly
// treated it as one).

import { resolveInput } from "./resolver";
import { parsePage } from "./parser/index";
import { resolveLinkedPair, type DraftGuardDeps } from "./draft-guard";
import { CliError } from "@belzabar/core";
import type { RawPageDependencies, RawPageResponse } from "./types/wire";

export interface EntityIds {
  name: string;
  entityType: "PAGE" | "COMPONENT";
  draftId: string | null;
  publishedId: string | null;
}

/**
 * Resolve an id / name / URL to the entity's name plus its draft AND published
 * ids in the active environment. Entity ids are env-local, so this resolves
 * against `Config.activeEnv` — pass an env-correct id (or a name) per env.
 *
 * The sibling is found via the row's `referenceId` link (never by name —
 * names are not unique). An unresolvable/contradictory link is an error.
 */
export async function resolveEntityIds(input: string, force = false): Promise<EntityIds> {
  const resolved = await resolveInput(input, force);
  return entityIdsFromRaw(resolved.response, resolved.entityType);
}

export async function entityIdsFromRaw(
  raw: RawPageResponse,
  entityType: "PAGE" | "COMPONENT",
  deps?: DraftGuardDeps,
): Promise<EntityIds> {
  const page = parsePage(raw);
  const link = await resolveLinkedPair(raw, deps);
  if (!link.ok) {
    throw new CliError(link.message, {
      code: "PD_DRAFT_LINK_UNRESOLVED",
      details: { id: page.id, name: page.name, reason: link.reason },
    });
  }
  return { name: page.name, entityType, draftId: link.draftId, publishedId: link.publishedId };
}

export type TranslationVerdict = "PASS" | "FAIL" | "N/A";

export interface BadPhraseKey {
  array: string; // the *__translated_phrases key it appeared in
  key: string;   // the malformed `.key` value
}

export interface TranslationCheckResult {
  verdict: TranslationVerdict;
  reason: string;
  mainKey: string;                  // `<publishedId>__translated_phrases`
  mainPresent: boolean;
  mainPhraseCount: number;
  mainEmbeddedDraftIds: string[];   // distinct ids embedded in main phrase keys
  expectedDraftId: string | null;
  mainDraftIdMatch: boolean | null; // null when no expected id is known
  phraseArrayCount: number;         // # of *__translated_phrases keys overall
  totalPhrases: number;
  badKeys: BadPhraseKey[];          // sample, capped at BAD_KEY_SAMPLE_CAP
  badKeyCount: number;              // full count
  dependencyKeys: string[];
}

const BAD_KEY_SAMPLE_CAP = 20;

function isWellFormedKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const parts = key.split(".");
  return parts.length >= 2 && (parts[0] === "page" || parts[0] === "symbol") && (parts[1] ?? "").length > 0;
}

/**
 * Validate the translation phrases inside a page-dependencies response.
 * `publishedId` is the id the API was queried with (it names the main array);
 * `expectedDraftId` is the id the main entity's phrase keys should embed —
 * pass null to skip rule 2.
 */
export function validateTranslationPhrases(
  deps: RawPageDependencies,
  publishedId: string,
  expectedDraftId: string | null,
): TranslationCheckResult {
  const mainKey = `${publishedId}__translated_phrases`;
  const dep = deps.dependencyJSON;

  const base = {
    mainKey,
    mainPresent: false,
    mainPhraseCount: 0,
    mainEmbeddedDraftIds: [] as string[],
    expectedDraftId,
    mainDraftIdMatch: null as boolean | null,
    phraseArrayCount: 0,
    totalPhrases: 0,
    badKeys: [] as BadPhraseKey[],
    badKeyCount: 0,
    dependencyKeys: [] as string[],
  };

  if (!dep || typeof dep !== "object") {
    return { ...base, verdict: "FAIL", reason: "dependencyJSON is missing or not an object." };
  }

  const dependencyKeys = Object.keys(dep);
  const tpKeys = dependencyKeys.filter((k) => k.endsWith("__translated_phrases"));

  if (tpKeys.length === 0) {
    return {
      ...base,
      dependencyKeys,
      verdict: "N/A",
      reason: "No __translated_phrases arrays — style/asset component with no translatable text.",
    };
  }

  const badKeys: BadPhraseKey[] = [];
  let badKeyCount = 0;
  let totalPhrases = 0;
  let mainPhraseCount = 0;
  const mainEmbedded = new Set<string>();

  for (const tpKey of tpKeys) {
    const entries = Array.isArray(dep[tpKey]) ? (dep[tpKey] as unknown[]) : [];
    for (const entry of entries) {
      totalPhrases++;
      const key = (entry as { key?: unknown })?.key;
      if (!isWellFormedKey(key)) {
        badKeyCount++;
        if (badKeys.length < BAD_KEY_SAMPLE_CAP) badKeys.push({ array: tpKey, key: String(key) });
        continue;
      }
      if (tpKey === mainKey) {
        mainPhraseCount++;
        mainEmbedded.add(key.split(".")[1] ?? "");
      }
    }
  }

  const mainPresent = tpKeys.includes(mainKey);
  const mainEmbeddedDraftIds = [...mainEmbedded];
  let mainDraftIdMatch: boolean | null = null;
  if (expectedDraftId && mainEmbeddedDraftIds.length > 0) {
    mainDraftIdMatch = mainEmbeddedDraftIds.every((id) => id === expectedDraftId);
  }

  const failures: string[] = [];
  if (badKeyCount > 0) failures.push(`${badKeyCount} phrase key(s) not page./symbol.<id>`);
  if (!mainPresent) failures.push(`main entity array '${mainKey}' is absent`);
  else if (mainPhraseCount === 0) failures.push(`main entity array '${mainKey}' is empty`);
  if (mainDraftIdMatch === false) {
    failures.push(
      `main phrases embed ${mainEmbeddedDraftIds.join(", ")}, expected ${expectedDraftId}`,
    );
  }

  const verdict: TranslationVerdict = failures.length === 0 ? "PASS" : "FAIL";
  const reason =
    verdict === "PASS"
      ? `${totalPhrases} phrase(s) across ${tpKeys.length} ` +
        `entit${tpKeys.length === 1 ? "y" : "ies"}; all keys well-formed` +
        `${mainDraftIdMatch ? "; main draft id matches" : ""}.`
      : failures.join("; ") + ".";

  return {
    verdict,
    reason,
    mainKey,
    mainPresent,
    mainPhraseCount,
    mainEmbeddedDraftIds,
    expectedDraftId,
    mainDraftIdMatch,
    phraseArrayCount: tpKeys.length,
    totalPhrases,
    badKeys,
    badKeyCount,
    dependencyKeys,
  };
}
