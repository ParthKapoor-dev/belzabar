// Ports the 10 rules from the old lib/parser.ts:validateConfig() to the new
// HydratedPage/ParsedNode world. Each rule is a pure function taking
// (HydratedPage, ctx) and returning ValidationIssue[]. Rule codes stay
// identical so external tooling keyed on them (if any) keeps working.

import { walkParsed } from "../../parser/nodes";
import type { HydratedPage, ValidationIssue } from "../../types/common";
import { bindingRoot, isBuiltinRoot, type RuleContext } from "../context";

export type { RuleContext } from "../context";

// ---------- Binding-level rules -----------------------------------------

/**
 * ORPHAN_BINDING — a `{%ref%}` whose root variable is not defined. One issue
 * per root (`{%x.a%}` + `{%x.b%}` → one issue for `x`).
 *   - author-owned config (layout, httpRequests, derived, …) → error
 *   - only inside `variables.generated` (editor-owned form configs) → warn:
 *     real sems-dev pages carry stale form-config bindings the editor never
 *     cleans up, and they render (PD-5 calibration).
 */
export function ruleOrphanBinding(
  _page: HydratedPage,
  ctx: RuleContext,
): ValidationIssue[] {
  const byRoot = new Map<string, { refs: string[]; generatedOnly: boolean }>();
  const visit = (ref: string, generatedOnly: boolean) => {
    const root = bindingRoot(ref);
    if (!root || isBuiltinRoot(root) || ctx.definedVarNames.has(root)) return;
    const entry = byRoot.get(root);
    if (entry) {
      if (!entry.refs.includes(ref)) entry.refs.push(ref);
      entry.generatedOnly &&= generatedOnly;
    } else {
      byRoot.set(root, { refs: [ref], generatedOnly });
    }
  };
  for (const ref of ctx.bindingRefs) visit(ref, false);
  for (const ref of ctx.generatedBindingRefs) visit(ref, true);

  const issues: ValidationIssue[] = [];
  for (const [root, { refs, generatedOnly }] of byRoot) {
    const shown = refs.slice(0, 3).map((r) => `{%${r}%}`).join(", ") + (refs.length > 3 ? ", …" : "");
    issues.push({
      code: "ORPHAN_BINDING",
      severity: generatedOnly ? "warn" : "error",
      message: generatedOnly
        ? `Binding ${shown} inside an editor-generated form config uses undefined variable "${root}"`
        : `Binding ${shown} used but variable "${root}" is not defined`,
      path: root,
    });
  }
  return issues;
}

/** UNUSED_VARIABLE — a userDefined/derived variable nothing reads or writes. */
export function ruleUnusedVariable(
  page: HydratedPage,
  ctx: RuleContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const own = [...page.variables.map((v) => v.name), ...page.derived.map((d) => d.name)];
  for (const name of new Set(own)) {
    const bare = name.trim();
    if (bare.startsWith("__") || bare.startsWith("$$")) continue;
    if (ctx.usedRoots.has(bare)) continue;
    issues.push({
      code: "UNUSED_VARIABLE",
      severity: "warn",
      message: `Variable "${name}" is defined but never referenced`,
      path: name,
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

/**
 * INVALID_JSON — the stringified `configuration` does not parse to an object.
 * The parser records it as a parse warning (and yields an empty page); lift it
 * into an error so no save can proceed on a config belz could not read.
 */
export function ruleInvalidJson(page: HydratedPage): ValidationIssue[] {
  return page.parseWarnings
    .filter((w) => w.startsWith("configuration JSON parse failed") || w.startsWith("configuration did not parse"))
    .map((w) => ({ code: "INVALID_JSON", severity: "error" as const, message: `Configuration is not valid JSON: ${w}` }));
}

export const EXISTING_RULES = [
  ruleInvalidJson,
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
