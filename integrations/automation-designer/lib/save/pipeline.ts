// `ad save` — the V2 save pipeline (Stage 5, D1).
//
//   1. resolveDraftTarget(uuid, "v2")      draft guard; its GET is the fresh live body
//   2. planV2Overlay(live, overlay)        overlay → body + L0 (only targets change)
//   3. runValidationGate                   lib/validate L1–L3 (L4 with --dry-run-compile)
//   4. confirm
//   5. freshness re-GET                    AD_VERSION_CONFLICT if the draft moved
//   6. POST /chain/v2
//   7. post-save verify re-GET             AD_SAVE_VERIFY_FAILED unless exactly the targets changed
//   8. compiled cache (both routes) + local method cache invalidated (always, once POSTed)
//
// The server ignores `metadata.version` (AD-08), so the freshness check is the
// only lost-update protection. A no-op V2 save changes only
// `metadata.version.name` and `metadata.internal.*` (live sems-dev 2026-09-28);
// those are the only paths verify tolerates besides the targets.

import { CliError } from "@belzabar/core";
import * as v2 from "../api/v2";
import { resolveDraftTarget } from "../draft-guard";
import { CacheManager } from "../cache";
import { logIntent } from "../args/confirm";
import { diffPaths, getAtPath, isUnder, jsonEqual } from "../serialize/diff";
import { planV2Overlay, type OverlayTarget } from "../serialize/v2";
import type { V2MethodResponse } from "../types/v2-wire";
import { postChainV2 } from "./api";
import { invalidateCompiledCache, type CompiledCacheResult } from "./compiled-cache";
import { runValidationGate, type ValidationFlags, type ValidationSummary } from "./validation";

/**
 * Server-owned bookkeeping: rewritten by every save (`metadata.version`,
 * `metadata.internal`) or outside the method content (`changelogs`: each
 * entry's `entityVersion` follows the draft version and its `user` block
 * carries `lastLoginDate`, which moves whenever that user logs in — live
 * sems-dev 2026-09-28). Ignored by the freshness check and the verify.
 */
export const SERVER_OWNED_ON_SAVE = ["metadata.version", "metadata.internal", "changelogs"];
/** Freshness: any content change is a conflict; changelog bookkeeping is not. */
const IGNORED_FOR_FRESHNESS = ["changelogs"];

export interface SaveV2Input {
  uuid: string;
  overlay: unknown;
  env: string;
  flags: ValidationFlags;
  warn: (msg: string) => void;
  /** Called after validation, before the freshness re-GET; throws to abort. */
  confirm: (action: string, details: Array<[string, string]>) => Promise<void>;
}

export interface SaveV2Data {
  action: "UPDATED";
  draftUuid: string;
  publishedUuid: string | null;
  switchedFromPublished: boolean;
  previousVersion: string | null;
  version: string | null;
  /** Overlay keys that changed the draft and were verified on the re-GET. */
  applied: string[];
  /** Overlay keys identical to the draft (nothing to change). */
  unchanged: string[];
  validation: ValidationSummary;
  compiledCache: CompiledCacheResult;
}

export function versionName(body: V2MethodResponse | null | undefined): string | null {
  const n = body?.metadata?.version?.name;
  return typeof n === "string" || typeof n === "number" ? String(n) : null;
}

export async function saveOverlayV2(input: SaveV2Input): Promise<SaveV2Data> {
  const guard = await resolveDraftTarget(input.uuid, "v2");
  if (!guard.ok) {
    throw new CliError(guard.message, { code: `AD_DRAFT_GUARD_${guard.reason}`, details: guard });
  }
  const draftUuid = guard.draft.uuid;
  const live = guard.draft.raw as V2MethodResponse;
  const plan = planV2Overlay(live, input.overlay, { env: input.env });
  for (const k of plan.unchanged) input.warn(`Overlay key ${k} is identical to the current draft; nothing to change.`);

  const validation = await runValidationGate(input.flags, {
    after: plan.body,
    before: live,
    overlayPaths: plan.targets.map((t) => t.path),
    env: input.env,
    action: "save",
    warn: input.warn,
  });

  const previousVersion = versionName(live);
  await input.confirm(`save draft ${draftUuid}`, [
    ["Method", String(live.name ?? guard.draft.name)],
    ["Draft UUID", draftUuid],
    ["Published UUID", guard.publishedUuid ?? "(none)"],
    ["Linked from PUBLISHED", guard.switchedFromPublished ? "Yes" : "No"],
    ["Current version", previousVersion ?? "?"],
    ["Changes", plan.applied.join(", ")],
    ["Validation", validation.skipped ? "SKIPPED (--no-validate)" : `${validation.warnings.length} warning(s)`],
  ]);

  // Freshness: nothing may have changed since the body the overlay was applied to.
  const fresh = await v2.fetchRawMethod(draftUuid);
  const moved = diffPaths(live, fresh).filter((p) => !IGNORED_FOR_FRESHNESS.some((s) => isUnder(p, s)));
  if (moved.length > 0) {
    throw new CliError(
      `Draft ${draftUuid} changed on the server since it was read (version ${previousVersion} → ${versionName(fresh)}). ` +
        "Nothing was saved; re-run the save against the current draft.",
      {
        code: "AD_VERSION_CONFLICT",
        details: { uuid: draftUuid, expectedVersion: previousVersion, currentVersion: versionName(fresh), changedPaths: moved.slice(0, 50) },
      },
    );
  }

  logIntent("POST", "/rest/api/automation/chain/v2", { draftUuid, version: previousVersion, changes: plan.applied });
  let compiledCache: CompiledCacheResult = { ok: false, uuids: [], routes: [] };
  let after: V2MethodResponse;
  try {
    await postChainV2(plan.body);
    after = await v2.fetchRawMethod(draftUuid);
  } finally {
    // Once the POST was attempted the stored body may have changed: always evict.
    compiledCache = await invalidateCompiledCache([draftUuid]);
    await CacheManager.invalidate(draftUuid);
    if (!compiledCache.ok) {
      input.warn(
        `Compiled-cache eviction failed on every route (${compiledCache.routes.map((r) => `${r.path} ${r.status ?? r.error}`).join("; ")}); ` +
          `tests may run the previous body. Retry with: belz cache ${draftUuid} --env ${input.env} --yes`,
      );
    }
  }

  verifySaved(draftUuid, live, after, plan.targets);

  return {
    action: "UPDATED",
    draftUuid,
    publishedUuid: guard.publishedUuid,
    switchedFromPublished: guard.switchedFromPublished,
    previousVersion,
    version: versionName(after),
    applied: plan.applied,
    unchanged: plan.unchanged,
    validation,
    compiledCache,
  };
}

/**
 * Post-save verify: every target landed with the requested value, and nothing
 * else changed except server-owned bookkeeping. Throws AD_SAVE_VERIFY_FAILED.
 */
export function verifySaved(uuid: string, before: V2MethodResponse, after: V2MethodResponse, targets: OverlayTarget[]): void {
  const notLanded = targets
    .filter((t) => !jsonEqual(getAtPath(after, t.path), t.value))
    .map((t) => ({ key: t.key, path: t.path, expected: t.value, actual: getAtPath(after, t.path) }));
  const unexpected = diffPaths(before, after).filter(
    (p) => !targets.some((t) => isUnder(p, t.path)) && !SERVER_OWNED_ON_SAVE.some((s) => isUnder(p, s)),
  );
  if (notLanded.length === 0 && unexpected.length === 0) return;
  throw new CliError(
    `Saved, but the draft read back does not match the request: ` +
      [
        notLanded.length ? `${notLanded.length} change(s) did not land (${notLanded.map((n) => n.key).join(", ")})` : "",
        unexpected.length ? `${unexpected.length} other path(s) changed (${unexpected.slice(0, 10).join(", ")})` : "",
      ]
        .filter(Boolean)
        .join("; ") +
      `. Inspect with: belz ad show ${uuid} --full`,
    {
      code: "AD_SAVE_VERIFY_FAILED",
      details: { uuid, version: versionName(after), notLanded, unexpected: unexpected.slice(0, 100) },
    },
  );
}
