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

import { CliError, Config, lifecycle, prompts, type CommandContext } from "@belzabar/core";
import { readFile } from "node:fs/promises";
import { pdApi } from "./api/index";
import { describeDraftGuardFailure, resolveDraftTarget } from "./draft-guard";
import { parsePage } from "./parser/index";
import type { HydratedPage, ValidationIssue } from "./types/common";
import type { WriteOverrides } from "./args/common";
import { partitionBySeverity } from "./validator/index";

/** Read + JSON-parse a user file; a missing/unreadable/invalid file is a CliError (PD-17). */
export async function readJsonFile(path: string, invalidCode: string, what: string): Promise<unknown> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new CliError(
      code === "ENOENT" ? `${what} file not found: ${path}` : `Cannot read ${what} file ${path}: ${String(err)}`,
      { code: code === "ENOENT" ? "PD_FILE_NOT_FOUND" : "PD_FILE_UNREADABLE", details: { path } },
    );
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new CliError(`${what} file parse failed: ${String(err)}`, { code: invalidCode, details: { path } });
  }
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
  if (yes) return;
  if (context.outputMode === "llm" || !process.stdin.isTTY) {
    throw new CliError(`"${action}" is a write operation. Pass --yes to confirm.`, {
      code: "CONFIRMATION_REQUIRED",
      details: { action, details: Object.fromEntries(details) },
    });
  }
  const pad = Math.max(0, ...details.map(([k]) => k.length));
  lifecycle.note(`About to ${action}`, details.map(([k, v]) => `${k.padEnd(pad)}  ${v}`).join("\n") || "(no details)");
  if (!(await prompts.confirm({ message: "Proceed?", initialValue: false }))) {
    throw new CliError("Aborted by user.", { code: "USER_ABORT", exitCode: 130 });
  }
}

/** One stderr audit line per PD write, naming the env it really targets. */
export function logIntent(action: string, pageId: string, meta: Record<string, unknown> = {}): void {
  let env: string;
  try {
    env = Config.activeEnv.name;
  } catch {
    env = "unknown";
  }
  process.stderr.write(`[belz pd write] ${JSON.stringify({ ts: new Date().toISOString(), action, pageId, env, ...meta })}\n`);
}
