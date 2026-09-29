// Core page rules: bindings, variables, form fields, tables, HTTP-call
// basics. Each rule is a pure (page, ctx) → ValidationIssue[] function; the
// severities come from lib/validator/catalogue.ts.

import { walkParsed } from "../../parser/nodes";
import type { HydratedPage, ValidationIssue } from "../../types/common";
import { issue } from "../catalogue";
import { bindingRoot, isBuiltinRoot, type Rule, type RuleContext } from "../context";

// ---------- Binding-level rules -----------------------------------------

/**
 * ORPHAN_BINDING — a `{%ref%}` whose root variable is not defined. One issue
 * per root (`{%x.a%}` + `{%x.b%}` → one issue for `x`).
 *   - author-owned config (layout, httpRequests, derived, …) → error
 *   - only inside `variables.generated` (editor-owned form configs) → warn:
 *     real pages carry stale form-config bindings the editor never cleans up,
 *     and they render.
 */
function ruleOrphanBinding(_page: HydratedPage, ctx: RuleContext): ValidationIssue[] {
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
    issues.push(
      generatedOnly
        ? issue("ORPHAN_BINDING", `Binding ${shown} inside an editor-generated form config uses undefined variable "${root}"`, { severity: "warn", path: root })
        : issue("ORPHAN_BINDING", `Binding ${shown} used but variable "${root}" is not defined`, { path: root }),
    );
  }
  return issues;
}

/** Editor-created variables every page carries (lifecycle trigger, route params). */
const EDITOR_BUILTIN_VARS = new Set(["onInit", "routeParams"]);

/**
 * UNUSED_VARIABLE — a userDefined/derived variable nothing reads or writes.
 * Not reported (false positives on real pages):
 *   - derived variables with `sideEffect: true` — they run for their effect
 *     (watchers that call `$api.setVariableValue`), nobody has to read them;
 *   - the editor built-ins `onInit` / `routeParams`;
 *   - names custom code reaches by string (see context.ts `usedRoots`).
 */
function ruleUnusedVariable(page: HydratedPage, ctx: RuleContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const own = [...page.variables.map((v) => v.name), ...page.derived.filter((d) => !d.sideEffect).map((d) => d.name)];
  const sideEffects = new Set(page.derived.filter((d) => d.sideEffect).map((d) => d.name));
  for (const name of new Set(own)) {
    const bare = name.trim();
    if (bare.startsWith("__") || bare.startsWith("$$")) continue;
    if (EDITOR_BUILTIN_VARS.has(bare) || sideEffects.has(name)) continue;
    if (ctx.usedRoots.has(bare)) continue;
    issues.push(issue("UNUSED_VARIABLE", `Variable "${name}" is defined but never referenced`, { path: name }));
  }
  return issues;
}

// ---------- Node-level rules --------------------------------------------

function ruleFormFieldProps(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind === "FORM_FIELD" && node.usesPropsInsteadOfField) {
      issues.push(
        issue("FORM_FIELD_PROPS", `"${node.tagName}" at ${node.nodeId} uses "props" instead of "field" — causes silent page crash`, {
          nodeId: node.nodeId,
          nodeName: node.tagName,
        }),
      );
    }
  });
  return issues;
}

function ruleChildrenNotArray(page: HydratedPage): ValidationIssue[] {
  // The parser already flags this as a parseWarning; lift it into a
  // validator issue so the gate blocks saves.
  return page.parseWarnings
    .filter((w) => w.includes("object-keyed children"))
    .map((w) =>
      issue("CHILDREN_NOT_ARRAY", w.replace("node ", "Node ").replace(" has object-keyed children", " has children as object instead of array — renders empty")),
    );
}

function ruleTableNoDatasource(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "DATA_TABLE") return;
    if (!node.datasourceState) {
      issues.push(
        issue("TABLE_NO_DATASOURCE", `"${node.tagName}" at ${node.nodeId} is missing datasourceState binding`, { nodeId: node.nodeId, nodeName: node.tagName }),
      );
    }
  });
  return issues;
}

function ruleInvalidSlideToggle(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.tagName === "mat-slide-toggle") {
      issues.push(
        issue("INVALID_SLIDE_TOGGLE", `"${node.tagName}" at ${node.nodeId} has no runtime declaration — use exp-form-field type "checkbox"`, {
          nodeId: node.nodeId,
          nodeName: node.tagName,
        }),
      );
    }
  });
  return issues;
}

function ruleInvalidExpansionHeader(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.tagName === "mat-expansion-panel-header") {
      issues.push(
        issue(
          "INVALID_EXPANSION_HEADER",
          `"${node.tagName}" at ${node.nodeId} is not a valid PD component — place content directly in mat-expansion-panel children`,
          { nodeId: node.nodeId, nodeName: node.tagName },
        ),
      );
    }
  });
  return issues;
}

function ruleMissingOnInitVar(page: HydratedPage, ctx: RuleContext): ValidationIssue[] {
  if (ctx.definedVarNames.has("onInit")) return [];
  return page.httpRequests
    .filter((call) => call.triggers.includes("onInit"))
    .map((call) => issue("MISSING_ONINIT_VAR", `HTTP call "${call.label}" triggers on "onInit" but no onInit variable is defined`));
}

function ruleEmptyEventMeta(page: HydratedPage): ValidationIssue[] {
  return page.httpRequests
    .filter((c) => c.eventMetaEmpty)
    .map((c) => issue("EMPTY_EVENT_META", `HTTP call "${c.label}" has empty eventMeta — shows "undefined - undefined" in the PD UI`));
}

function ruleDynamicColsInitial(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "DATA_TABLE") return;
    if (!node.hasDynamicColumns) return;
    if (!node.hasInitialValueOnColumnsVar) return;
    issues.push(
      issue(
        "DYNAMIC_COLS_INITIAL",
        `"${node.tagName}" at ${node.nodeId} has dynamic [columns] but the referenced variable has initialValue — may crash with "_columnCssClassName is not iterable"`,
        { nodeId: node.nodeId, nodeName: node.tagName },
      ),
    );
  });
  return issues;
}

/**
 * INVALID_JSON — the stringified `configuration` does not parse to an object.
 * The parser records it as a parse warning (and yields an empty page); lift it
 * into an error so no save can proceed on a config belz could not read.
 */
function ruleInvalidJson(page: HydratedPage): ValidationIssue[] {
  return page.parseWarnings
    .filter((w) => w.startsWith("configuration JSON parse failed") || w.startsWith("configuration did not parse"))
    .map((w) => issue("INVALID_JSON", `Configuration is not valid JSON: ${w}`));
}

export const EXISTING_RULES: Rule[] = [
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
];
