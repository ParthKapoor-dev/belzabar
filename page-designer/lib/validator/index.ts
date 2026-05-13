// Validator façade. `validateHydrated(page)` is the single entry point used
// by the `validate` command, the `preflight` command, and (as a gate) by the
// `save` command.

import { extractBindingReferences } from "../parser/refs";
import type { HydratedPage, ValidationIssue } from "../types/common";
import { EXISTING_RULES, type RuleContext } from "./rules/existing";
import { INVARIANT_RULES } from "./rules/invariants";

export function validateHydrated(page: HydratedPage): ValidationIssue[] {
  const bindingRefs = new Set(extractBindingReferences(page.rawConfigurationString));
  const definedVarNames = new Set<string>([
    ...page.variables.map((v) => v.name),
    ...page.derived.map((d) => d.name),
  ]);
  const ctx: RuleContext = { bindingRefs, definedVarNames };

  const issues: ValidationIssue[] = [];
  for (const rule of EXISTING_RULES) issues.push(...rule(page, ctx));
  for (const rule of INVARIANT_RULES) issues.push(...rule(page, ctx));
  return issues;
}

export function partitionBySeverity(issues: ValidationIssue[]) {
  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warn"),
  };
}

export type { ValidationIssue } from "../types/common";
