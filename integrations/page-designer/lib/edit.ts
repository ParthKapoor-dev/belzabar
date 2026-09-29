// The shared write pipeline for `save`, `publish` and `history restore`:
//
//   1. resolveWriteTarget — draft-guard (referenceId pair); a PUBLISHED page
//      with no draft needs --allow-published (PD-6)
//   2. the command plans + validates on the guard's snapshot (fail fast,
//      before asking for --yes)
//   3. withLock(target) → FRESH fetch, re-plan, re-validate, compare the
//      versionId with the snapshot (PD-4), write, verify
//
// Validation errors block unless --force-validation; bypassed errors are
// reported in `bypassedErrors`.

import { CliError, type CommandContext, confirmWrite, logWriteIntent, readJsonInput } from "@belzabar/core";
import { pdApi } from "./api/index";
import { describeDraftGuardFailure, resolveDraftTarget } from "./draft-guard";
import { parsePage } from "./parser/index";
import type { HydratedPage, ValidationIssue } from "./types/common";
import type { WriteOverrides } from "./args/common";
import { partitionBySeverity } from "./validator/index";

/** Read + JSON-parse a user file; a missing/unreadable/invalid file is a CliError (PD-17). */
export function readJsonFile(path: string, invalidCode: string, what: string): Promise<unknown> {
  return readJsonInput(path, {
    unreadable: (err, missing) =>
      new CliError(missing ? `${what} file not found: ${path}` : `Cannot read ${what} file ${path}: ${String(err)}`, {
        code: missing ? "PD_FILE_NOT_FOUND" : "PD_FILE_UNREADABLE",
        details: { path },
      }),
    invalid: (err) => new CliError(`${what} file parse failed: ${String(err)}`, { code: invalidCode, details: { path } }),
  });
}

export interface WriteTarget {
  /** The id every write goes to (the draft, or the PUBLISHED page under --allow-published). */
  targetId: string;
  publishedId: string | null;
  switchedFromPublished: boolean;
  /** Parsed target as fetched by the guard (pre-lock snapshot). */
  snapshot: HydratedPage;
}

export async function resolveWriteTarget(
  pageId: string,
  overrides: WriteOverrides,
  warn: (message: string) => void,
  verb: string,
): Promise<WriteTarget> {
  const guard = await resolveDraftTarget(pageId);
  if (guard.ok) {
    if (guard.switchedFromPublished) {
      warn(`ℹ Input resolved to PUBLISHED page; ${verb} the linked draft ${guard.draftId}.`);
    }
    return {
      targetId: guard.draftId,
      publishedId: guard.publishedId,
      switchedFromPublished: guard.switchedFromPublished,
      snapshot: guard.draft,
    };
  }
  if (guard.reason === "PUBLISHED_NO_DRAFT" && overrides.allowPublished) {
    warn(`⚠ --allow-published: ${verb} PUBLISHED page ${guard.publishedId} (${guard.name}) directly.`);
    const raw = await pdApi.fetchPage(guard.publishedId);
    if (!raw) throw new CliError(`Page ${guard.publishedId} not found.`, { code: "PD_NOT_FOUND" });
    return { targetId: guard.publishedId, publishedId: guard.publishedId, switchedFromPublished: false, snapshot: parsePage(raw) };
  }
  throw describeDraftGuardFailure(guard);
}

/** Fetch the target fresh (inside the lock). */
export async function fetchFresh(targetId: string): Promise<HydratedPage> {
  const raw = await pdApi.fetchPage(targetId);
  if (!raw) throw new CliError(`Page ${targetId} disappeared before the write.`, { code: "PD_NOT_FOUND" });
  return parsePage(raw);
}

/**
 * The live PUBLISHED page as a validation baseline (NEW-5 / NEW-OTH-2). The
 * single-page GET is served from a server-side cache that can return the
 * PRE-publish version for a while after a publish, so it is checked against
 * the page's history: when history holds a newer version than the GET, that
 * version's body is the baseline. History unreadable → the GET, with a warning.
 */
export async function fetchPublishedBaseline(publishedId: string, warn: (message: string) => void): Promise<HydratedPage | null> {
  const raw = await pdApi.fetchPage(publishedId);
  if (!raw) return null;
  const getVersion = typeof raw.versionId === "number" ? raw.versionId : -1;
  try {
    const entries = await pdApi.historyList(publishedId);
    const newest = entries
      .filter((e) => typeof e.id === "number" && (e.pageId === undefined || e.pageId === publishedId))
      .reduce((max, e) => Math.max(max, e.id), -1);
    if (newest > getVersion) {
      const body = await pdApi.historyGet(newest);
      if (body) return parsePage(body);
      warn(`Published baseline: history version ${newest} of ${publishedId} is unreadable; validating against the (possibly stale) GET.`);
    }
  } catch (e) {
    warn(`Published baseline: history of ${publishedId} is unreadable (${(e as Error).message}); validating against the (possibly stale) GET.`);
  }
  return parsePage(raw);
}

const WARNING_PRINT_CAP = 10;

export interface GateResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  bypassedErrors: ValidationIssue[];
}

/**
 * Validation gate: errors throw PD_VALIDATION_FAILED unless --force-validation
 * (then they are returned as bypassedErrors). `announce` controls whether the
 * bypass / warnings are printed (only once per command).
 */
export function gateValidation(
  issues: ValidationIssue[],
  forceValidation: boolean,
  warn: (message: string) => void,
  announce = true,
): GateResult {
  const { errors, warnings } = partitionBySeverity(issues);
  if (errors.length > 0 && !forceValidation) {
    throw new CliError(
      `Validator found ${errors.length} error(s). Refusing to write. Fix them, or pass --force-validation to bypass.`,
      {
        code: "PD_VALIDATION_FAILED",
        details: {
          issues: errors.map((e) => ({ code: e.code, message: e.message, nodeId: e.nodeId ?? null, introduced: e.introduced ?? null })),
        },
      },
    );
  }
  if (announce) {
    if (errors.length > 0) {
      warn(`⚠ --force-validation: bypassing ${errors.length} validator error(s):`);
      for (const e of errors) warn(`  [${e.code}] ${e.message}`);
    }
    const shown = warnings.filter((w) => !w.preExisting);
    for (const w of shown.slice(0, WARNING_PRINT_CAP)) warn(`⚠ ${w.code}: ${w.message}`);
    if (shown.length > WARNING_PRINT_CAP) {
      warn(`⚠ … and ${shown.length - WARNING_PRINT_CAP} more validator warning(s) (see data.validation / \`belz pd validate\`).`);
    }
  }
  return { errors, warnings, bypassedErrors: forceValidation ? errors : [] };
}

/** Warn (and describe) when the page changed between the guard's snapshot and the in-lock fetch. */
export function versionDrift(
  snapshot: HydratedPage,
  fresh: HydratedPage,
  warn: (message: string) => void,
): { from: number | null; to: number | null } | null {
  if (snapshot.versionId === fresh.versionId) return null;
  warn(
    `ℹ Page ${fresh.id} changed since it was read (versionId ${snapshot.versionId ?? "?"} → ${fresh.versionId ?? "?"}); ` +
      `the edit was re-applied to the latest version inside the lock.`,
  );
  return { from: snapshot.versionId, to: fresh.versionId };
}

/**
 * Write confirmation: `--yes` proceeds; an interactive terminal (human mode)
 * is asked; --llm or a non-TTY without --yes is CONFIRMATION_REQUIRED.
 */
export async function requireConfirmation(
  context: Pick<CommandContext, "outputMode">,
  yes: boolean,
  action: string,
  details: Array<[string, string]>,
): Promise<void> {
  await confirmWrite({
    yes,
    outputMode: context.outputMode,
    action,
    details,
    requiredMessage: `"${action}" is a write operation. Pass --yes to confirm.`,
    refuseWithoutTty: true,
    abortExitCode: 130,
    detailsShape: "object",
  });
}

/** One stderr audit line per PD write, naming the env it really targets. */
export function logIntent(action: string, pageId: string, meta: Record<string, unknown> = {}): void {
  logWriteIntent("pd", { action, pageId }, meta, { withEnv: true });
}
