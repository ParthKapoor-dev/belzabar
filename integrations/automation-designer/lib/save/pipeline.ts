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
import { planV2Overlay, type OverlayTarget, type V2OverlayPlan } from "../serialize/v2";
import { isObj } from "../serialize/compact";
import { loadServiceCatalog, servicesOfOps } from "./services";
import type { V2MethodResponse } from "../types/v2-wire";
import { postChainV2 } from "./api";
import { invalidateCompiledCache, type CompiledCacheResult } from "./compiled-cache";
import { runValidationGate, type ValidationFinding, type ValidationFlags, type ValidationSummary } from "./validation";

/**
 * Server-owned bookkeeping: rewritten by every save (`metadata.version`,
 * `metadata.internal`) or outside the method content (`changelogs`: each
 * entry's `entityVersion` follows the draft version and its `user` block
 * carries `lastLoginDate`, which moves whenever that user logs in — live
 * sems-dev 2026-09-28). `testSuite` is the method's persisted test cases,
 * managed by `ad test-case`, not by a save: a V2 POST that carries it makes
 * the server rebuild the suite from the (possibly stale) copy — new assertion
 * ids, createdOn/updatedOn, chainVersionId — while a POST without it leaves
 * the suite intact (live sems-dev 2026-09-29). So the save never sends it
 * (`postBody`) and the freshness check and the verify ignore it.
 */
export const SERVER_OWNED_ON_SAVE = ["metadata.version", "metadata.internal", "changelogs", "testSuite"];
/** Freshness: any content change is a conflict; changelog / test-suite bookkeeping is not. */
const IGNORED_FOR_FRESHNESS = ["changelogs", "testSuite"];

/** The body actually POSTed: everything but `testSuite` (see SERVER_OWNED_ON_SAVE). */
export function postBody(body: V2MethodResponse): V2MethodResponse {
  const { testSuite: _suite, ...rest } = body;
  return rest as V2MethodResponse;
}

export interface SaveV2Input {
  uuid: string;
  overlay: unknown;
  env: string;
  flags: ValidationFlags;
  warn: (msg: string) => void;
  /** Called after validation, before the freshness re-GET; throws to abort. */
  confirm: (action: string, details: Array<[string, string]>) => Promise<void>;
  /** Plan + validate only: nothing is written (no confirm, no POST). */
  dryRun?: boolean;
}

export interface SaveDryRunData {
  action: "DRY_RUN";
  draftUuid: string;
  version: string | null;
  applied: string[];
  unchanged: string[];
  /** New step order: fetched position, or null for a new step. Present for structural ops. */
  order?: Array<number | null>;
  /** No blocking validator findings: the real save would pass the gate. */
  valid: boolean;
  validation: DryRunValidation;
}

/** Validator result as a dry run reports it: blocking findings are data, not an error. */
export interface DryRunValidation {
  skipped: boolean;
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  layersRun: string[];
}

/** Run the gate, turning AD_VALIDATION_FAILED into data (for --dry-run). */
export async function dryRunValidation(run: () => Promise<ValidationSummary>): Promise<DryRunValidation> {
  try {
    const v = await run();
    return { skipped: v.skipped, errors: [], warnings: v.warnings, layersRun: v.layersRun };
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== "AD_VALIDATION_FAILED") throw err;
    const d = err.details as { warnings: ValidationFinding[]; blocking: ValidationFinding[]; layersRun: string[] };
    return { skipped: false, errors: d.blocking, warnings: d.warnings.filter((w) => !d.blocking.includes(w)), layersRun: d.layersRun };
  }
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

export function saveOverlayV2(input: SaveV2Input & { dryRun: true }): Promise<SaveDryRunData>;
export function saveOverlayV2(input: SaveV2Input): Promise<SaveV2Data>;
export async function saveOverlayV2(input: SaveV2Input): Promise<SaveV2Data | SaveDryRunData> {
  const guard = await resolveDraftTarget(input.uuid, "v2");
  if (!guard.ok) {
    throw new CliError(guard.message, { code: `AD_DRAFT_GUARD_${guard.reason}`, details: guard });
  }
  const draftUuid = guard.draft.uuid;
  const live = guard.draft.raw as V2MethodResponse;
  const ops = isObj(input.overlay) ? input.overlay.ops : undefined;
  const catalog = ops !== undefined ? await loadServiceCatalog(servicesOfOps(live, ops)) : undefined;
  const plan = planV2Overlay(live, input.overlay, { env: input.env, catalog });
  for (const k of plan.unchanged) input.warn(`Overlay key ${k} is identical to the current draft; nothing to change.`);

  const gate = {
    after: plan.body,
    before: live,
    overlayPaths: plan.structural ? plan.structural.touched : plan.targets.map((t) => t.path),
    env: input.env,
    action: "save",
    warn: input.warn,
  };
  if (input.dryRun) {
    const v = await dryRunValidation(() => runValidationGate(input.flags, gate));
    return {
      action: "DRY_RUN",
      draftUuid,
      version: versionName(live),
      applied: plan.applied,
      unchanged: plan.unchanged,
      ...(plan.structural ? { order: plan.structural.order } : {}),
      valid: v.errors.length === 0,
      validation: v,
    };
  }
  const validation = await runValidationGate(input.flags, gate);

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
    await postChainV2(postBody(plan.body));
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

  verifyPlan(draftUuid, live, after, plan);

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

/** Verify with the check that fits the plan (leaf targets, or the whole body for ops). */
export function verifyPlan(uuid: string, before: V2MethodResponse, after: V2MethodResponse, plan: V2OverlayPlan): void {
  if (plan.structural) verifyStructural(uuid, plan.body, after, plan.structural.touched);
  else verifySaved(uuid, before, after, plan.targets);
}

/** uuid-like keys the server pads to 36 characters. */
const PADDED_KEYS = new Set(["uuid", "id", "automationAPIId", "automationApiId"]);

/**
 * Post-save verify for structural ops and creates: the draft read back must
 * equal `expected` (the body sent) everywhere, except server bookkeeping and,
 * under a `touched` path (a new/updated step or field; "" = the whole body),
 * fields the server fills in (ids, uuids, types) and uuid padding. A value
 * belz sent that reads back different or missing is `notLanded`; any other
 * difference is `unexpected`. Throws AD_SAVE_VERIFY_FAILED.
 */
export function verifyStructural(uuid: string, expected: unknown, after: unknown, touched: string[]): void {
  const all = touched.includes("");
  const underTouched = (p: string) => all || touched.some((t) => isUnder(p, t));
  const notLanded: Array<{ path: string; expected: unknown; actual: unknown }> = [];
  const unexpected: string[] = [];
  for (const p of diffPaths(expected, after)) {
    if (SERVER_OWNED_ON_SAVE.some((s) => isUnder(p, s))) continue;
    const want = getAtPath(expected, p);
    const got = getAtPath(after, p);
    if (underTouched(p)) {
      if (want === undefined) continue; // server-filled
      const last = p.replace(/\[\d+\]$/, "").split(".").pop() ?? "";
      if (PADDED_KEYS.has(last) && typeof want === "string" && typeof got === "string" && want.trim().toLowerCase() === got.trim().toLowerCase()) continue;
      notLanded.push({ path: p, expected: want, actual: got });
    } else unexpected.push(p);
  }
  if (notLanded.length === 0 && unexpected.length === 0) return;
  throw new CliError(
    `Saved, but the draft read back does not match the request: ` +
      [
        notLanded.length ? `${notLanded.length} value(s) did not land (${notLanded.slice(0, 10).map((n) => n.path).join(", ")})` : "",
        unexpected.length ? `${unexpected.length} other path(s) changed (${unexpected.slice(0, 10).join(", ")})` : "",
      ]
        .filter(Boolean)
        .join("; ") +
      `. Inspect with: belz ad show ${uuid} --full`,
    {
      code: "AD_SAVE_VERIFY_FAILED",
      details: { uuid, version: versionName(after as V2MethodResponse), notLanded: notLanded.slice(0, 100), unexpected: unexpected.slice(0, 100) },
    },
  );
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
