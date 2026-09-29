// Every code the PD validator can emit: default severity, where the rule
// comes from, and the figma-to-pd / pd-review equivalent when it has another
// name. `commands/validate/help.txt` lists the same codes; a unit test keeps
// the two in sync with what the rules actually emit.

import type { ValidationSeverity } from "../types/common";

export interface PdRuleInfo {
  severity: ValidationSeverity;
  /** figma-to-pd validate-pd-config.py code, pd-review section, or "belz". */
  source: string;
  description: string;
}

export const PD_RULES: Record<string, PdRuleInfo> = {
  // ── structural errors ───────────────────────────────────────────────────
  INVALID_JSON: { severity: "error", source: "belz", description: "configuration is not valid JSON" },
  ROOT_LAYOUT_MALFORMED: { severity: "error", source: "figma L1", description: "root is not a div; page root lacks unSelectable:true; component root lacks isSymbol:true" },
  ORPHAN_BINDING: { severity: "error", source: "pd-review 3a", description: "{%var%} whose root variable is not defined (warn inside editor-generated form configs)" },
  FORM_FIELD_PROPS: { severity: "error", source: "page-designer", description: "exp-form-field with props instead of field (blank page)" },
  CHILDREN_NOT_ARRAY: { severity: "error", source: "page-designer", description: "children is an object instead of an array" },
  INVALID_SLIDE_TOGGLE: { severity: "error", source: "page-designer", description: "mat-slide-toggle has no runtime declaration" },
  INVALID_EXPANSION_HEADER: { severity: "error", source: "page-designer", description: "mat-expansion-panel-header is not a PD component" },
  PHONE_FIELD_TYPE: { severity: "error", source: "page-designer", description: "exp-form-field type phone renders 0-height" },
  DUPLICATE_ELEMENT_IDS: { severity: "error", source: "pd-review 3a", description: "two nodes share an id / _elementId" },
  V1: { severity: "error", source: "figma V1", description: "variables / variables.userDefined / .generated is not the bucket-of-arrays shape" },
  HTTP_NOT_ARRAY: { severity: "error", source: "page-designer", description: "httpRequests.userDefined / .generated is not an array" },
  // ── warnings (escalated to errors when an edit introduces them) ──────────
  DERIVED_IN_INNERHTML: { severity: "warn", source: "page-designer", description: "derived var bound to innerHTML / textContent renders empty" },
  ARRAY_INITIAL_VALUE: { severity: "warn", source: "figma V3", description: "variable with an array initialValue (ArrayNode cannot be cast)" },
  BUTTON_DYNAMIC_CLASSNAME: { severity: "warn", source: "figma R2", description: "button with a [className] binding renders invisible" },
  MISSING_NODE_ID: { severity: "warn", source: "pd-review 3a", description: "node without an id" },
  ORPHAN_HTTP_TRIGGER: { severity: "warn", source: "pd-review 3a", description: "HTTP call triggered by an undefined variable (never fires)" },
  ORPHAN_EVENT_TARGET: { severity: "warn", source: "pd-review 3a", description: "event handler writes this.x where x is undefined" },
  V4: { severity: "warn", source: "figma V4", description: "variable type outside the PD type enum (String/Boolean/Number/Any/KeyValue/… are valid in the PD editor)" },
  T2: { severity: "warn", source: "figma T2", description: "table rowData variable is not {rows:[…]} (or a raw array bound directly)" },
  T4: { severity: "warn", source: "figma T4", description: "{rows:[…]} table variable not typed Any" },
  T5: { severity: "warn", source: "figma T5", description: "{%$src.$row.X%} in plain HTML inside a dict cellLayout" },
  R1: { severity: "warn", source: "figma R1", description: "static isVisible next to [isVisible]" },
  DIALOG_VISIBILITY: { severity: "warn", source: "page-designer", description: "exp-layout-dialog toggled with [visible]/[isVisible] instead of [show]" },
  ITEM_DIRECT_ACCESS: { severity: "warn", source: "page-designer", description: "{%$item.field%} instead of {%$item.value%}?.field" },
  HTTP_HARDCODED_URL: { severity: "warn", source: "pd-review 3c", description: "HTTP call with an absolute URL" },
  // ── warnings ────────────────────────────────────────────────────────────
  UNUSED_VARIABLE: { severity: "warn", source: "pd-review 3a", description: "variable nothing reads or writes (side-effect derived vars, onInit/routeParams and names used via $api.get/setVariableValue are not reported)" },
  UNUSED_HTTP_REQUEST: { severity: "warn", source: "pd-review 3a", description: "HTTP call with no trigger" },
  TABLE_NO_DATASOURCE: { severity: "warn", source: "figma T1", description: "exp-data-table without datasourceState" },
  T1: { severity: "warn", source: "figma T1", description: "exp-data-table datasourceState is not \"initial\"" },
  T3: { severity: "warn", source: "figma T3", description: "table row field over 400 chars (pre-baked HTML)" },
  T6: { severity: "warn", source: "figma T6", description: "HTML inside table rowData" },
  C5: { severity: "warn", source: "figma C5", description: "column key missing from some initial rows" },
  DYNAMIC_COLS_INITIAL: { severity: "warn", source: "page-designer", description: "dynamic [columns] whose variable has an initialValue" },
  MISSING_ONINIT_VAR: { severity: "warn", source: "page-designer", description: "HTTP trigger onInit without an onInit variable" },
  EMPTY_EVENT_META: { severity: "warn", source: "page-designer", description: "serviceCall.eventMeta is {}" },
  CUSTOM_HTML_IN_COMPONENT: { severity: "warn", source: "page-designer", description: "raw <input>/<select>/<textarea>/<table> node" },
  HTTP_NO_ERROR_HANDLER: { severity: "warn", source: "pd-review 3d", description: "HTTP call without handler.error" },
  HTTP_MUTATION_ON_LOAD: { severity: "warn", source: "pd-review 3c", description: "write-looking HTTP call (PUT/PATCH/DELETE or save/update/delete… label) triggered on page load" },
  HTTP_NOT_AUTHORIZED: { severity: "warn", source: "pd-review 3c", description: "/rest/ call without request.isAuthorized:true" },
  IMG_NO_ALT: { severity: "warn", source: "pd-review 3d", description: "<img> without alt text" },
  H1: { severity: "warn", source: "figma H1", description: "exp-html-template over 400 chars (not a single SVG)" },
  F1: { severity: "warn", source: "figma F1", description: "raw <input>/<select>/<textarea> inside a template / innerHTML" },
  CSS_NOT_SCOPED: { severity: "warn", source: "page-designer", description: "style rules without the .latest-version prefix (one issue per page)" },
  U1: { severity: "warn", source: "figma U1", description: "CSS url(...) with a literal newline" },
  // ── --recursive only (page ↔ symbol checks) ─────────────────────────────
  SYMBOL_NOT_FOUND: { severity: "warn", source: "pd-review 3b", description: "a symbol the page uses does not exist in this environment" },
  SYMBOL_UNKNOWN_INPUT: { severity: "warn", source: "pd-review 3b", description: "symbol instance binds an input the symbol does not declare" },
  SYMBOL_UNKNOWN_EVENT: { severity: "warn", source: "pd-review 3b", description: "symbol instance handles an event the symbol does not declare" },
  SYMBOL_NESTING_DEPTH: { severity: "warn", source: "pd-review 3b", description: "symbol chain deeper than 3 levels" },
};
