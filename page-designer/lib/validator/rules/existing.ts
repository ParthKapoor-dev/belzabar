// Ports the 10 rules from the old lib/parser.ts:validateConfig() to the new
// HydratedPage/ParsedNode world. Each rule is a pure function taking
// (HydratedPage, ctx) and returning ValidationIssue[]. Rule codes stay
// identical so external tooling keyed on them (if any) keeps working.

import { walkParsed } from "../../parser/nodes";
import type { HydratedPage, ValidationIssue } from "../../types/common";

export interface RuleContext {
  // Derived once by the validator and reused by every rule.
  bindingRefs: Set<string>;
  definedVarNames: Set<string>;
}

// ---------- Binding-level rules -----------------------------------------

export function ruleOrphanBinding(
  page: HydratedPage,
  ctx: RuleContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const ref of ctx.bindingRefs) {
    if (ref === "null") continue;
    if (ref.startsWith("$item")) continue; // loop-local
    if (!ctx.definedVarNames.has(ref)) {
      issues.push({
        code: "ORPHAN_BINDING",
        severity: "error",
        message: `Binding {%${ref}%} used but variable "${ref}" is not defined`,
      });
    }
  }
  return issues;
}

export function ruleUnusedVariable(
  page: HydratedPage,
  ctx: RuleContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const name of ctx.definedVarNames) {
    if (name.startsWith("__") || name.startsWith("$$")) continue;
    if (ctx.bindingRefs.has(name)) continue;
    if (page.rawConfigurationString.includes(`this.${name}`)) continue;
    issues.push({
      code: "UNUSED_VARIABLE",
      severity: "warn",
      message: `Variable "${name}" is defined but never referenced`,
    });
  }
  return issues;
}

// ---------- Node-level rules --------------------------------------------

export function ruleFormFieldProps(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind === "FORM_FIELD" && node.usesPropsInsteadOfField) {
      issues.push({
        code: "FORM_FIELD_PROPS",
        severity: "error",
        message: `"${node.tagName}" at ${node.nodeId} uses "props" instead of "field" — causes silent page crash`,
        nodeId: node.nodeId,
        nodeName: node.tagName,
      });
    }
  });
  return issues;
}

export function ruleChildrenNotArray(page: HydratedPage): ValidationIssue[] {
  // The parser already flags this as a parseWarning; lift it into a
  // validator issue so the gate blocks saves.
  return page.parseWarnings
    .filter((w) => w.includes("object-keyed children"))
    .map((w) => ({
      code: "CHILDREN_NOT_ARRAY",
      severity: "error" as const,
      message: w.replace("node ", "Node ").replace(" has object-keyed children", " has children as object instead of array — renders empty"),
    }));
}

export function ruleTableNoDatasource(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "DATA_TABLE") return;
    if (!node.datasourceState) {
      issues.push({
        code: "TABLE_NO_DATASOURCE",
        severity: "warn",
        message: `"${node.tagName}" at ${node.nodeId} is missing datasourceState binding`,
        nodeId: node.nodeId,
        nodeName: node.tagName,
      });
    }
  });
  return issues;
}

export function ruleInvalidSlideToggle(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.tagName === "mat-slide-toggle") {
      issues.push({
        code: "INVALID_SLIDE_TOGGLE",
        severity: "error",
        message: `"${node.tagName}" at ${node.nodeId} has no runtime declaration — use exp-form-field type "checkbox"`,
        nodeId: node.nodeId,
        nodeName: node.tagName,
      });
    }
  });
  return issues;
}

export function ruleInvalidExpansionHeader(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.tagName === "mat-expansion-panel-header") {
      issues.push({
        code: "INVALID_EXPANSION_HEADER",
        severity: "error",
        message: `"${node.tagName}" at ${node.nodeId} is not a valid PD component — place content directly in mat-expansion-panel children`,
        nodeId: node.nodeId,
        nodeName: node.tagName,
      });
    }
  });
  return issues;
}

export function ruleMissingOnInitVar(
  page: HydratedPage,
  ctx: RuleContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const call of page.httpRequests) {
    if (!call.triggers.includes("onInit")) continue;
    if (ctx.definedVarNames.has("onInit")) continue;
    issues.push({
      code: "MISSING_ONINIT_VAR",
      severity: "warn",
      message: `HTTP call "${call.label}" triggers on "onInit" but no onInit variable is defined`,
    });
  }
  return issues;
}

export function ruleEmptyEventMeta(page: HydratedPage): ValidationIssue[] {
  return page.httpRequests
    .filter((c) => c.eventMetaEmpty)
    .map((c) => ({
      code: "EMPTY_EVENT_META",
      severity: "warn" as const,
      message: `HTTP call "${c.label}" has empty eventMeta — shows "undefined - undefined" in the PD UI`,
    }));
}

export function ruleDynamicColsInitial(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "DATA_TABLE") return;
    if (!node.hasDynamicColumns) return;
    if (!node.hasInitialValueOnColumnsVar) return;
    issues.push({
      code: "DYNAMIC_COLS_INITIAL",
      severity: "warn",
      message: `"${node.tagName}" at ${node.nodeId} has dynamic [columns] but the referenced variable has initialValue — may crash with "_columnCssClassName is not iterable"`,
      nodeId: node.nodeId,
      nodeName: node.tagName,
    });
  });
  return issues;
}

// 10th rule: INVALID_JSON is enforced upstream by the parser (the HydratedPage
// will be malformed before we reach the validator). We surface it via parse
// warnings converted to errors in index.ts, so there's no standalone rule
// function here.

export const EXISTING_RULES = [
  ruleOrphanBinding,
  ruleUnusedVariable,
  ruleFormFieldProps,
  ruleChildrenNotArray,
  ruleTableNoDatasource,
  ruleInvalidSlideToggle,
  ruleInvalidExpansionHeader,
  ruleMissingOnInitVar,
  ruleEmptyEventMeta,
  ruleDynamicColsInitial,
] as const;
