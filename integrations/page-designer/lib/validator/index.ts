// Validator façade.
//
//   validateHydrated(page)        — every rule over one page (validate, preflight
//                                   without an overlay, history show, publish).
//   validateEdit(before, after)   — the edit gate used by save / preflight
//                                   --overlay / history restore. Diff-aware:
//                                   only what the edit INTRODUCES can block.
//
// Severities (lib/validator/catalogue.ts) are calibrated so real editor output
// (tests/fixtures/real) has no errors; see tests/unit/validator-real.test.ts.

import type { HydratedPage, ValidationIssue } from "../types/common";
import { escalatesWhenIntroduced } from "./catalogue";
import { buildRuleContext } from "./context";
import { EXISTING_RULES } from "./rules/existing";
import { INVARIANT_RULES } from "./rules/invariants";
import { LINT_RULES } from "./rules/lint";

export function validateHydrated(page: HydratedPage): ValidationIssue[] {
  const ctx = buildRuleContext(page);
  const issues: ValidationIssue[] = [];
  for (const rule of EXISTING_RULES) issues.push(...rule(page, ctx));
  for (const rule of INVARIANT_RULES) issues.push(...rule(page, ctx));
  for (const rule of LINT_RULES) issues.push(...rule(page, ctx));
  return issues;
}

function fingerprint(i: ValidationIssue): string {
  return `${i.code}\u0000${i.nodeId ?? ""}\u0000${i.path ?? ""}\u0000${i.message}`;
}

/**
 * Validate `after` relative to `before`:
 *   - an issue already present on `before` is marked `preExisting` and never
 *     blocks (an error is downgraded to warn) — the edit did not cause it;
 *   - an issue new in `after` is marked `introduced`; a code the catalogue
 *     marks `escalate` is raised to an error.
 */
export function validateEdit(before: HydratedPage, after: HydratedPage): ValidationIssue[] {
  const prior = new Set(validateHydrated(before).map(fingerprint));
  return validateHydrated(after).map((issue): ValidationIssue => {
    if (prior.has(fingerprint(issue))) {
      return { ...issue, severity: "warn", preExisting: true };
    }
    const severity = escalatesWhenIntroduced(issue.code) ? "error" : issue.severity;
    return { ...issue, severity, introduced: true };
  });
}

export function partitionBySeverity(issues: ValidationIssue[]) {
  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warn"),
  };
}

export type { ValidationIssue } from "../types/common";
