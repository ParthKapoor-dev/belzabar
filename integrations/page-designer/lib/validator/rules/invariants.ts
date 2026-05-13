// New invariant rules — the ones the old parser-based validator couldn't
// express. Each cites a failure mode from docs/api-notes.md §Failure-mode
// catalog. Shapes mirror existing.ts: (page, ctx) → ValidationIssue[].

import { walkParsed } from "../../parser/nodes";
import type { HydratedPage, ValidationIssue } from "../../types/common";
import type { RuleContext } from "./existing";

// DERIVED_IN_INNERHTML — derived variables bound to innerHTML/textContent render empty.
// Cites: docs/api-notes.md §Silent-page-crash
export function ruleDerivedInInnerHtml(
  page: HydratedPage,
  _ctx: RuleContext,
): ValidationIssue[] {
  const derivedNames = new Set(page.derived.map((d) => d.name));
  if (derivedNames.size === 0) return [];
  const issues: ValidationIssue[] = [];

  const checkBinding = (value: unknown, node: { nodeId: string; tagName: string }) => {
    if (typeof value !== "string") return;
    const regex = /\{%([^%]+)%\}/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(value)) !== null) {
      const ref = m[1];
      if (ref && derivedNames.has(ref)) {
        issues.push({
          code: "DERIVED_IN_INNERHTML",
          severity: "error",
          message: `Node "${node.tagName}" at ${node.nodeId} uses derived variable "${ref}" in innerHTML/textContent — renders empty`,
          nodeId: node.nodeId,
          nodeName: node.tagName,
        });
      }
    }
  };

  walkParsed(page.layout, (node) => {
    const props = node.props;
    checkBinding(props["innerHTML"], node);
    checkBinding(props["[innerHTML]"], node);
    checkBinding(props["[textContent]"], node);
  });

  return issues;
}

// ARRAY_INITIAL_VALUE — server throws `ArrayNode cannot be cast to ObjectNode`
// when a userDefined variable has an array initialValue.
// Cites: docs/api-notes.md §Silent-page-crash
export function ruleArrayInitialValue(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const v of page.variables) {
    if (Array.isArray(v.initialValue)) {
      issues.push({
        code: "ARRAY_INITIAL_VALUE",
        severity: "error",
        message: `Variable "${v.name}" has an array initialValue — server throws ArrayNode cannot be cast to ObjectNode. Remove initialValue or populate via service call.`,
      });
    }
  }
  return issues;
}

// PHONE_FIELD_TYPE — exp-form-field type="phone" renders with 0 height.
// Cites: docs/api-notes.md §Silent-page-crash
export function rulePhoneFieldType(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "FORM_FIELD") return;
    if (node.fieldType === "phone") {
      issues.push({
        code: "PHONE_FIELD_TYPE",
        severity: "error",
        message: `Form field "${node.nodeId}" uses type:"phone" which renders with 0 height — use type:"text" with a phone placeholder`,
        nodeId: node.nodeId,
        nodeName: node.tagName,
      });
    }
  });
  return issues;
}

// ROOT_LAYOUT_MALFORMED — page root missing unSelectable/_elementId, or
// symbol root missing isSymbol:true.
// Cites: docs/api-notes.md §Silent-page-crash (both "layout must be root div
// node" and "symbols use isSymbol:true")
export function ruleRootLayoutMalformed(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const layout = page.layout;

  if (page.entityType === "PAGE") {
    // Expect: name==div, unSelectable==true, has _elementId
    if (layout.kind === "GENERIC" && layout.nodeId === "__missing_root") {
      issues.push({
        code: "ROOT_LAYOUT_MALFORMED",
        severity: "error",
        message: `Page has no root layout node — the entire page will render blank`,
      });
      return issues;
    }
    const rawLayout = layout.raw as Record<string, unknown> | null;
    if (!rawLayout || typeof rawLayout !== "object") {
      issues.push({
        code: "ROOT_LAYOUT_MALFORMED",
        severity: "error",
        message: `Page root is not a proper layout node`,
      });
      return issues;
    }
    if (rawLayout.name !== "div") {
      issues.push({
        code: "ROOT_LAYOUT_MALFORMED",
        severity: "error",
        message: `Page root must be name:"div", found "${rawLayout.name}"`,
      });
    }
    if (rawLayout.unSelectable !== true) {
      issues.push({
        code: "ROOT_LAYOUT_MALFORMED",
        severity: "error",
        message: `Page root must set unSelectable:true — entire page will render blank otherwise`,
      });
    }
    if (typeof rawLayout._elementId !== "string" || rawLayout._elementId.length === 0) {
      issues.push({
        code: "ROOT_LAYOUT_MALFORMED",
        severity: "error",
        message: `Page root is missing _elementId`,
      });
    }
  } else {
    // SYMBOL root must have isSymbol:true and must NOT use unSelectable.
    const rawLayout = layout.raw as Record<string, unknown> | null;
    if (!rawLayout || typeof rawLayout !== "object") return issues;
    if (rawLayout.isSymbol !== true) {
      issues.push({
        code: "ROOT_LAYOUT_MALFORMED",
        severity: "error",
        message: `Symbol root must set isSymbol:true — produces incorrect JSON even if PD still renders it`,
      });
    }
    if (rawLayout.unSelectable === true) {
      issues.push({
        code: "ROOT_LAYOUT_MALFORMED",
        severity: "error",
        message: `Symbol root uses unSelectable:true — use isSymbol:true instead`,
      });
    }
  }

  return issues;
}

// BUTTON_DYNAMIC_CLASSNAME — <button> with [className] binding renders invisible.
// Cites: docs/api-notes.md §Silent-page-crash
export function ruleButtonDynamicClassName(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "BUTTON") return;
    if (node.hasDynamicClassName) {
      issues.push({
        code: "BUTTON_DYNAMIC_CLASSNAME",
        severity: "error",
        message: `Button "${node.nodeId}" uses dynamic [className] binding — renders invisible. Use static className or wrap class logic in a derived variable`,
        nodeId: node.nodeId,
        nodeName: node.tagName,
      });
    }
  });
  return issues;
}

// DUPLICATE_ELEMENT_IDS — two nodes share id or _elementId.
// Cites: docs/api-notes.md (stable nodeIds are required for partial updates
// to target correctly).
export function ruleDuplicateElementIds(page: HydratedPage): ValidationIssue[] {
  const idCount = new Map<string, number>();
  const elemIdCount = new Map<string, number>();

  walkParsed(page.layout, (node) => {
    idCount.set(node.nodeId, (idCount.get(node.nodeId) ?? 0) + 1);
    if (node.elementId) {
      elemIdCount.set(node.elementId, (elemIdCount.get(node.elementId) ?? 0) + 1);
    }
  });

  const issues: ValidationIssue[] = [];
  for (const [id, count] of idCount) {
    if (count > 1) {
      issues.push({
        code: "DUPLICATE_ELEMENT_IDS",
        severity: "error",
        message: `Node id "${id}" appears ${count}× in the tree — ids must be unique`,
        nodeId: id,
      });
    }
  }
  for (const [id, count] of elemIdCount) {
    if (count > 1) {
      issues.push({
        code: "DUPLICATE_ELEMENT_IDS",
        severity: "error",
        message: `_elementId "${id}" appears ${count}× in the tree — _elementIds must be unique`,
      });
    }
  }
  return issues;
}

// CUSTOM_HTML_IN_COMPONENT — raw HTML form/table elements should be PD components.
// Cites: expertly page-designer/SKILL.md critical-component table.
const BANNED_TAGS = new Set([
  "input",
  "select",
  "textarea",
  "table",
  "mat-slide-toggle",            // also caught by INVALID_SLIDE_TOGGLE (error);
  "mat-expansion-panel-header", // also caught by INVALID_EXPANSION_HEADER (error).
]);
export function ruleCustomHtmlInComponent(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (!BANNED_TAGS.has(node.tagName)) return;
    // Skip the two already covered as errors — no point double-reporting.
    if (node.tagName === "mat-slide-toggle") return;
    if (node.tagName === "mat-expansion-panel-header") return;
    issues.push({
      code: "CUSTOM_HTML_IN_COMPONENT",
      severity: "warn",
      message: `Node "${node.tagName}" at ${node.nodeId} is raw HTML — use a PD component (exp-form-field, exp-data-table, etc.) for consistent rendering`,
      nodeId: node.nodeId,
      nodeName: node.tagName,
    });
  });
  return issues;
}

export const INVARIANT_RULES = [
  ruleDerivedInInnerHtml,
  ruleArrayInitialValue,
  rulePhoneFieldType,
  ruleRootLayoutMalformed,
  ruleButtonDynamicClassName,
  ruleDuplicateElementIds,
  ruleCustomHtmlInComponent,
] as const;
