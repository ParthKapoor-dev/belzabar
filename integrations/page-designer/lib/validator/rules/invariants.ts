// Renderer invariants: configs the PD runtime renders blank, invisible or not
// at all (docs/api-notes.md §Failure-mode catalog). Same shape as existing.ts:
// (page, ctx) → ValidationIssue[], severities from lib/validator/catalogue.ts.

import { walkParsed } from "../../parser/nodes";
import type { HydratedPage, ValidationIssue } from "../../types/common";
import { issue } from "../catalogue";
import { bindingRoot, type Rule } from "../context";

/**
 * DERIVED_IN_INNERHTML — derived variables bound to innerHTML/textContent
 * render empty. A warning: many live pages do this (derived vars live in
 * variables.userDefined there); validateEdit blocks a new one.
 */
function ruleDerivedInInnerHtml(page: HydratedPage): ValidationIssue[] {
  const derivedNames = new Set(page.derived.map((d) => d.name.trim()));
  if (derivedNames.size === 0) return [];
  const issues: ValidationIssue[] = [];

  const checkBinding = (value: unknown, node: { nodeId: string; tagName: string }) => {
    if (typeof value !== "string") return;
    const regex = /\{%([^%]+)%\}/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(value)) !== null) {
      // `{% name %}` and `{%name.x%}` bind the derived var too.
      const ref = m[1] ? bindingRoot(m[1].trim()) : null;
      if (ref && derivedNames.has(ref)) {
        issues.push(
          issue("DERIVED_IN_INNERHTML", `Node "${node.tagName}" at ${node.nodeId} uses derived variable "${ref}" in innerHTML/textContent — renders empty`, {
            nodeId: node.nodeId,
            nodeName: node.tagName,
          }),
        );
      }
    }
  };

  walkParsed(page.layout, (node) => {
    const props = node.props;
    checkBinding(props["innerHTML"], node);
    checkBinding(props["[innerHTML]"], node);
    checkBinding(props["[textContent]"], node);
    checkBinding(props["textContent"], node);
  });

  return issues;
}

/**
 * ARRAY_INITIAL_VALUE — the server throws `ArrayNode cannot be cast to
 * ObjectNode` for a userDefined variable with an array initialValue. A
 * warning: editor-saved pages carry them; validateEdit blocks a new one.
 */
function ruleArrayInitialValue(page: HydratedPage): ValidationIssue[] {
  return page.variables
    .filter((v) => Array.isArray(v.initialValue))
    .map((v) =>
      issue(
        "ARRAY_INITIAL_VALUE",
        `Variable "${v.name}" has an array initialValue — server throws ArrayNode cannot be cast to ObjectNode. Remove initialValue or populate via service call.`,
      ),
    );
}

/** PHONE_FIELD_TYPE — exp-form-field type="phone" renders with 0 height. */
function rulePhoneFieldType(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "FORM_FIELD") return;
    if (node.fieldType === "phone") {
      issues.push(
        issue("PHONE_FIELD_TYPE", `Form field "${node.nodeId}" uses type:"phone" which renders with 0 height — use type:"text" with a phone placeholder`, {
          nodeId: node.nodeId,
          nodeName: node.tagName,
        }),
      );
    }
  });
  return issues;
}

/**
 * A style-only symbol: the editor saves its layout as just `{isSymbol: true}`
 * (no name, no children), or leaves `layout` out entirely, and the component
 * only contributes `styles`.
 */
export function isStyleOnlySymbol(page: HydratedPage): boolean {
  const inner = (page.rawConfiguration ?? {}) as { layout?: unknown; styles?: unknown };
  if (page.entityType === "COMPONENT" && inner.layout === undefined) {
    return typeof inner.styles === "string" && inner.styles.trim() !== "";
  }
  const l = page.layout.raw as Record<string, unknown> | null;
  return (
    page.entityType === "COMPONENT" &&
    !!l && typeof l === "object" && !Array.isArray(l) &&
    l.isSymbol === true && l.name === undefined &&
    (l.children === undefined || (Array.isArray(l.children) && l.children.length === 0))
  );
}

/**
 * ROOT_LAYOUT_MALFORMED — the root layout node is missing or not the shape the
 * renderer needs. Every editor-saved root is `name:"div", unSelectable:true`;
 * components also set `isSymbol:true`, and many pages have no root
 * `_elementId`. So: a page root must be a div with unSelectable:true, a
 * component root a div with isSymbol:true.
 */
function ruleRootLayoutMalformed(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const layout = page.layout;
  const malformed = (message: string) => issue("ROOT_LAYOUT_MALFORMED", message);

  if (isStyleOnlySymbol(page)) return issues;
  if (layout.kind === "GENERIC" && layout.nodeId === "__missing_root") {
    issues.push(malformed(`${page.entityType === "PAGE" ? "Page" : "Component"} has no root layout node — it will render blank`));
    return issues;
  }
  const rawLayout = layout.raw as Record<string, unknown> | null;
  if (!rawLayout || typeof rawLayout !== "object" || Array.isArray(rawLayout)) {
    issues.push(malformed(`Root layout is not a proper layout node`));
    return issues;
  }
  if (rawLayout.name !== "div") {
    issues.push(malformed(`Root layout must be name:"div", found "${String(rawLayout.name)}"`));
  }
  if (page.entityType === "PAGE") {
    if (rawLayout.unSelectable !== true) {
      issues.push(malformed(`Page root must set unSelectable:true — entire page will render blank otherwise`));
    }
  } else if (rawLayout.isSymbol !== true) {
    issues.push(malformed(`Component root must set isSymbol:true — produces incorrect JSON even if PD still renders it`));
  }
  return issues;
}

/**
 * BUTTON_DYNAMIC_CLASSNAME — a <button> with a [className] binding renders
 * invisible. A warning (live pages carry it); validateEdit blocks a new one.
 */
function ruleButtonDynamicClassName(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (node.kind !== "BUTTON") return;
    if (node.hasDynamicClassName) {
      issues.push(
        issue(
          "BUTTON_DYNAMIC_CLASSNAME",
          `Button "${node.nodeId}" uses dynamic [className] binding — renders invisible. Use static className or wrap class logic in a derived variable`,
          { nodeId: node.nodeId, nodeName: node.tagName },
        ),
      );
    }
  });
  return issues;
}

/** DUPLICATE_ELEMENT_IDS — two nodes share id or _elementId (partial updates need unique ids). */
function ruleDuplicateElementIds(page: HydratedPage): ValidationIssue[] {
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
      issues.push(issue("DUPLICATE_ELEMENT_IDS", `Node id "${id}" appears ${count}× in the tree — ids must be unique`, { nodeId: id }));
    }
  }
  for (const [id, count] of elemIdCount) {
    // A node without `id` uses its _elementId as nodeId, so the same
    // duplicate would otherwise be reported twice.
    if (count > 1 && !((idCount.get(id) ?? 0) > 1)) {
      issues.push(issue("DUPLICATE_ELEMENT_IDS", `_elementId "${id}" appears ${count}× in the tree — _elementIds must be unique`, { nodeId: id }));
    }
  }
  return issues;
}

/**
 * CUSTOM_HTML_IN_COMPONENT — raw HTML form/table elements should be PD
 * components. mat-slide-toggle / mat-expansion-panel-header are errors of
 * their own (INVALID_SLIDE_TOGGLE / INVALID_EXPANSION_HEADER), so not here.
 */
const BANNED_TAGS = new Set(["input", "select", "textarea", "table"]);
function ruleCustomHtmlInComponent(page: HydratedPage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walkParsed(page.layout, (node) => {
    if (!BANNED_TAGS.has(node.tagName)) return;
    issues.push(
      issue(
        "CUSTOM_HTML_IN_COMPONENT",
        `Node "${node.tagName}" at ${node.nodeId} is raw HTML — use a PD component (exp-form-field, exp-data-table, etc.) for consistent rendering`,
        { nodeId: node.nodeId, nodeName: node.tagName },
      ),
    );
  });
  return issues;
}

export const INVARIANT_RULES: Rule[] = [
  ruleDerivedInInnerHtml,
  ruleArrayInitialValue,
  rulePhoneFieldType,
  ruleRootLayoutMalformed,
  ruleButtonDynamicClassName,
  ruleDuplicateElementIds,
  ruleCustomHtmlInComponent,
];
