// New invariant rules — the ones the old parser-based validator couldn't
// express. Each cites a failure mode from docs/api-notes.md §Failure-mode
// catalog. Shapes mirror existing.ts: (page, ctx) → ValidationIssue[].

import { walkParsed } from "../../parser/nodes";
import type { HydratedPage, ValidationIssue } from "../../types/common";
import type { RuleContext } from "../context";

// DERIVED_IN_INNERHTML — derived variables bound to innerHTML/textContent render empty.
// Cites: docs/api-notes.md §Silent-page-crash
// Severity: warn. 8 of the 15 sems-dev fixtures do this on live pages (derived
// vars live in variables.userDefined there); validateEdit escalates it to an
// error when an edit introduces one.
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
          severity: "warn",
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
// Severity: warn. Real editor-saved pages carry array initialValues (2 of the
// 15 sems-dev fixtures), so it is not a hard error on an existing page; the
// edit gate (validateEdit) escalates it to an error when an edit INTRODUCES one.
export function ruleArrayInitialValue(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const v of page.variables) {
    if (Array.isArray(v.initialValue)) {
      issues.push({
        code: "ARRAY_INITIAL_VALUE",
        severity: "warn",
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

// ROOT_LAYOUT_MALFORMED — the root layout node is missing or is not the
// shape the renderer needs.
// Cites: docs/api-notes.md §Silent-page-crash (both "layout must be root div
// node" and "symbols use isSymbol:true")
// Calibrated against real editor output (PD-5): every sems-dev root is
// `name:"div", unSelectable:true`; components ALSO set `isSymbol:true`, and
// about half the pages have no root `_elementId`. So: a page root must be a
// div with unSelectable:true; a component root must be a div with
// isSymbol:true. `_elementId` and "unSelectable on a symbol" are not checked.
/**
 * A style-only symbol (sems-dev `style_*` components): the editor saves its
 * layout as just `{isSymbol: true}` — no name, no children — and the component
 * only contributes `styles`. Found live in Stage 7 (style_parent_site_inner_pages).
 */
export function isStyleOnlySymbol(page: HydratedPage): boolean {
  const l = page.layout.raw as Record<string, unknown> | null;
  return (
    page.entityType === "COMPONENT" &&
    !!l && typeof l === "object" && !Array.isArray(l) &&
    l.isSymbol === true && l.name === undefined &&
    (l.children === undefined || (Array.isArray(l.children) && l.children.length === 0))
  );
}

export function ruleRootLayoutMalformed(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const layout = page.layout;
  const issue = (message: string): ValidationIssue => ({ code: "ROOT_LAYOUT_MALFORMED", severity: "error", message });

  if (layout.kind === "GENERIC" && layout.nodeId === "__missing_root") {
    issues.push(issue(`${page.entityType === "PAGE" ? "Page" : "Component"} has no root layout node — it will render blank`));
    return issues;
  }
  const rawLayout = layout.raw as Record<string, unknown> | null;
  if (!rawLayout || typeof rawLayout !== "object" || Array.isArray(rawLayout)) {
    issues.push(issue(`Root layout is not a proper layout node`));
    return issues;
  }
  if (isStyleOnlySymbol(page)) return issues;
  if (rawLayout.name !== "div") {
    issues.push(issue(`Root layout must be name:"div", found "${String(rawLayout.name)}"`));
  }
  if (page.entityType === "PAGE") {
    if (rawLayout.unSelectable !== true) {
      issues.push(issue(`Page root must set unSelectable:true — entire page will render blank otherwise`));
    }
  } else if (rawLayout.isSymbol !== true) {
    issues.push(issue(`Component root must set isSymbol:true — produces incorrect JSON even if PD still renders it`));
  }
  return issues;
}

// BUTTON_DYNAMIC_CLASSNAME — <button> with [className] binding renders invisible.
// Cites: docs/api-notes.md §Silent-page-crash
// Severity: warn (the live "Student Application" page has 4 and renders);
// escalated to an error by validateEdit when an edit introduces one.
export function ruleButtonDynamicClassName(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "BUTTON") return;
    if (node.hasDynamicClassName) {
      issues.push({
        code: "BUTTON_DYNAMIC_CLASSNAME",
        severity: "warn",
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
    // PD-26: a node without `id` uses its _elementId as nodeId, so the same
    // duplicate would otherwise be reported twice.
    if (count > 1 && !((idCount.get(id) ?? 0) > 1)) {
      issues.push({
        code: "DUPLICATE_ELEMENT_IDS",
        severity: "error",
        message: `_elementId "${id}" appears ${count}× in the tree — _elementIds must be unique`,
        nodeId: id,
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
