---
name: page-designer
description: |
  Page Designer JSON configuration tool for creating and updating interactive UI components. Use this skill when working with:
  - Creating or modifying pd.json files for Page Designer
  - Updating existing pages (full or partial updates via API)
  - Building UI layouts with custom components (exp-tabs-panel, exp-data-table, mat-accordion, exp-form-builder, etc.)
  - Configuring data binding with {%variableName%} syntax
  - Setting up event handlers using $api methods
  - Converting Figma designs to Page Designer JSON
  - Working with the Expertly AI Toolbar portal pages
  - Binding service calls / API calls to fetch and display data
  MANDATORY TRIGGERS: pd.json, page designer, Page Designer, data binding, exp-tabs, exp-data-table, mat-accordion, exp-form-builder, {%variable%}, pd-update, update page, modify page
---

> **⚠️ CRITICAL RULE: ALWAYS USE PD COMPONENTS — NEVER CUSTOM HTML**
>
> **Before generating ANY node**, look up the correct PD component from `components/` directory.
> You MUST use Expertly PD components. You MUST NOT invent HTML/CSS equivalents.
>
> | When you see this in a design | USE THIS PD component | NEVER do this |
> |------|------|------|
> | Text input | `exp-form-field` type `text` | `<input type="text">` or innerHTML with `<input>` |
> | Dropdown/select | `exp-form-field` type `select` | `<select>` or custom div dropdowns |
> | Textarea | `exp-form-field` type `textarea` | `<textarea>` or contenteditable divs |
> | Checkbox | `exp-form-field` type `checkbox` | `<input type="checkbox">` |
> | Radio buttons | `exp-form-field` type `radio` | `<input type="radio">` |
> | Date picker | `exp-form-field` type `date` | `<input type="date">` |
> | File upload | `exp-form-field` type `file-upload` | `<input type="file">` |
> | Data table | `exp-data-table` | `<table>` or custom div grids |
> | Tabs | `exp-tabs-panel` + `mat-tab` | Custom button+visibility tabs |
> | Accordion | `mat-accordion` + `mat-expansion-panel` | Custom collapsible divs |
> | Chart | `exp-chart-card` | Custom canvas/SVG charts |
> | Modal dialog | `exp-layout-dialog` | Custom overlay divs |
> | Loading spinner | `exp-loader` | Custom CSS spinners |
> | Toast message | `wis-toast` | Custom notification divs |
> | Toggle/switch | `exp-form-field` type `checkbox` | `mat-slide-toggle` (has NO runtime declaration — causes "Invalid declaration undefined" crash) |
> | Breadcrumbs | `wis-breadcrumbs` | Custom span/separator breadcrumbs |
> | Breadcrumbs | `wis-breadcrumbs` | Custom span+separator HTML |
> | Icons | `exp-svg-icon` (built-in first) | Only use `exp-html-template` if icon not in built-in set |
> | Multi-column grid | Multicolumn Container (`col col-*`) | `display: grid` or custom CSS media queries |
> | Pagination | `exp-pagination-controls` | Custom prev/next buttons |
>
> **If unsure which component to use → ASK the developer. Do NOT invent custom HTML.**
> **When fixing components → REPLACE the entire node. Do NOT just modify CSS on wrong elements.**

# Page Designer Skill

Create and modify Page Designer JSON configurations parsed by a library to render interactive UI components.

## Workflow

```
Figma Design → pd.json (Page Designer config) → Library Parser → Rendered UI
```

**Always ask the developer upfront:** "Is there any service call / API that needs to be bound to this page?"

### Build Strategy

- **Single-component page** (just a form or table): Generate complete pd.json in one pass.
- **Multi-section page** (2+ sections): Create `requirements.md` first, then build section by section.
- **Complex page** (4+ sections): **ALWAYS** use section-by-section. Never attempt full-page generation in one shot.

**Section-by-section workflow:**
1. **Analyze** the design → identify all sections (sidebar, header, filters, form, table, footer)
2. **Create `requirements.md`** → list each section with its PD components, variables, service calls, build order, status
3. **Build one section at a time** → read component JSON from `components/`, generate fragment, merge into pd.json, test in Preview
4. **Update `requirements.md`** after each section → mark complete, note adjustments
5. **Final integration** → full-page review, CSS polish, cross-section interaction testing

---

## pd.json Structure

```json
{
  "layout": {
    "id": "__node_id_root_001",
    "name": "div",
    "props": {
      "layout": { "gap": "16px", "type": "flex", "direction": "column" }
    },
    "children": [],
    "_elementId": "__element_id_root_001",
    "unSelectable": true,
    "__LAYOUT_CONFIG_METADATA": {}
  },
  "styles": "",
  "__version": 5,
  "variables": {},
  "httpRequests": {}
}
```

> **⚠️ CRITICAL: `layout` MUST be a full root div node** — NOT just `{children: [...]}` or `{}`. The root node MUST have: `id`, `name: "div"`, `props` (with `layout`), `children` (array), `_elementId`, `unSelectable: true`, and `__LAYOUT_CONFIG_METADATA: {}`. Using `layout: {children: [...]}` without the proper root node structure causes the **entire page to render blank** — no page name, no content, no errors in console.

> **IMPORTANT**: Use `variables` (NOT `context`) and `httpRequests` (NOT `http`). Wrong keys = compile errors.
> **Never modify `__version`** — preserve whatever value the page already has. New pages typically use `5`.

---

## Variables

```json
"variables": {
  "generated": [],
  "userDefined": [
    {"name": "myVar", "type": "String", "initialValue": "hello", "translateInitialValue": false, "__LAYOUT_CONFIG_METADATA": {}}
  ],
  "derived": []
}
```

**Types:** `String`, `Boolean`, `Number`, `Any`, `KeyValue`, `PAGINATION_STORE`

**Rules:**
- Each variable MUST be an object with `{name, type, initialValue, translateInitialValue, __LAYOUT_CONFIG_METADATA}` — Jackson requires ObjectNode format
- **Arrays cannot be initialValue** → server throws `ArrayNode cannot be cast to ObjectNode`. Use service calls to populate arrays.
- For variables holding arrays (table data, options), use `type: "Any"` with no initialValue

### Derived Variables

Compute values from dependencies using JavaScript:
```json
{"name": "filteredItems", "from": ["items", "filter"], "spec": "(function(params) { return (params.items || []).filter(function(i) { return i.status === params.filter; }); })", "filterFn": "(function(data) { return !!data.items; })", "sideEffect": false}
```
Fields: `name` (required), `from` (required, dependency array), `spec` (required, JS function), `filterFn` (optional guard), `sideEffect` (optional, default false).

> **⚠️ CRITICAL LIMITATION:** Derived variables can ONLY be used in **component property bindings** (e.g., `[data]`, `[options]`, `[(value)]`, `[isVisible]`, `[totalItems]`). They CANNOT be rendered as text/HTML content in div nodes via `innerHTML`, `[innerHTML]`, or `[textContent]` — all three render empty. Use derived variables to feed data into PD components, not to display text directly.

**Working patterns for derived variables:**
- `"[options]": "{%derivedList%}"` on select fields
- `"[data]": "{%filteredData%}"` on data tables
- `"[isVisible]": "{%showCondition%}"` for conditional rendering
- `"[totalItems]": "{%computedTotal%}"` on pagination

**Not working:**
- `"[innerHTML]": "{%derivedText%}"` on divs → renders empty
- `"[textContent]": "{%derivedText%}"` on divs → renders empty
- `"innerHTML": "Text: {%derivedVar%}"` → shows literal text `Text: {%derivedVar%}`

---

## Node Structure

```json
{
  "id": "__node_id_XXX",
  "name": "div",
  "props": {
    "layout": {"gap": "16px", "type": "flex", "direction": "column", "alignItems": "center"},
    "className": "my-class",
    "innerHTML": "Text content",
    "[isVisible]": "{%showElement%}",
    "isVisible": true
  },
  "children": [],  // ⚠️ MUST be an array [] — NEVER use objects {0:..., 1:...}
  "events": {"click": [["this.varName", "(function(data){ ... })"]]},
  "_elementId": "__element_id_XXX"
}
```

- `name` = component type (`div`, `button`, `exp-data-table`, etc.)
- `button` renders as Angular Material button. Text goes in `innerHTML`.
- **Never use `[className]` dynamic binding on buttons** → causes invisible rendering. Use static `className` or derived variables.
- `div` renders as `EXP-LAYOUT` — needs children or innerHTML to be visible.

---

## Data Binding

| Syntax | Usage | Example |
|--------|-------|---------|
| `{%var%}` | Interpolation | `"{%userName%}"` |
| `[prop]` | Dynamic binding | `"[isVisible]": "{%show%}"` |
| `[(value)]` | Two-way (forms) | `"[(value)]": "{%email%}"` |
| `{%$item%}` | Loop item | `"{%$item.name%}"` |
| `{%$item.index%}` | Loop index | `"{%$item.index%}+1"` |

**Supported in expressions:** variable refs, comparisons (`===`, `!==`, `>`, `<`), logical (`&&`, `||`, `!`), arithmetic, string concat.
**NOT supported:** `.map()`, `.filter()`, `.length`, ternary on `[className]`, function calls → use derived variables instead.

---

## Event Handlers

```json
"events": {
  "click": [["this.varName", "(function(data){ var $api = data.$api; $api.setVariableValue('myVar', newValue); })"]]
}
```

**$api methods:** `$api.getVariableValue('name')`, `$api.setVariableValue('name', value)`

**Handler context:** `data.$api` (always), `data.$event` (always), `data.$item` (inside cellLayout loops), `data.$index` (inside cellLayout loops).

> **⚠️ KNOWN ISSUE: Button click events may silently fail.** Plain `<button>` elements with `events.click` handlers render visually but click events may produce NO effect and NO console errors. The `this.varName` in the handler array must reference an existing variable in `userDefined` or `derived` — otherwise you get "Can not determine data source" errors. If button events don't fire, verify the variable exists and consider using PD component events (e.g., `rowClick` on data tables, `action` on form builders, `pageChange` on pagination) which are confirmed working.

---

## Components

> **⚠️ REMINDER: Always use PD components from `components/` directory. Never create custom HTML equivalents.**

### Available Element Types (from PD Editor)

**Layout:** Slot, Accordion, Adaptive Element, Aside, Breadcrumbs, Column Wrapper, Component Loader, Container, Custom HTML, Expansion Panel, Heading, Horizontal Line, Image, Label, Link, List Item, List of Values, Loader, Map, Google Map, Movable Container, Multicolumn Container, Ordered List, Outlet, Pagination Controls, Paragraph, Radio Group, SVG Icon, Search Box, Slide Toggle, Span

**Interactive:** Button, Chart, Checkbox, Data Table, Dialog, Dialog Actions, Dialog Content, File Preview, File Upload, Form

**Form Fields:** Base Button Field, Checkbox Field, Date Field, Email Field, File Upload Field, HTML Field, Icon Button Field, Number Field, Password Field, Phone Number Field, Push Button List Autocomplete Field, Push Button List Field, Radio Group Field, Repeater Field, Richtext Field, Select Field, Text Field, Textarea Field, Time Picker Field

### Component Library (`components/` directory)

```
components/
├── form-fields/          ← ⚠️ USE THESE — never raw HTML inputs
│   ├── text-field.json, textarea-field.json, select-field.json
│   ├── checkbox-field.json, radio-group-field.json, date-field.json
│   ├── email-field.json, number-field.json, password-field.json
│   ├── phone-number-field.json, file-upload-field.json
│   ├── richtext-field.json, time-picker-field.json
│   └── form-builder.json
├── layout/               ← ⚠️ USE THESE — never custom CSS layouts
│   ├── multicolumn-container.json, tabs-panel.json
│   ├── accordion.json, dialog.json
├── data-display/         ← ⚠️ USE THESE — never HTML tables
│   ├── data-table.json, chart-card.json
│   ├── pagination-controls.json, svg-icon.json
├── feedback/
│   ├── loader.json, toast.json
└── navigation/
    ├── breadcrumbs.json, redirect.json
```

**Usage:** Find the matching component JSON → copy the `node` structure → change IDs, labels, variable names → add `requiredVariables` to `variables.userDefined`.

### exp-form-field (All Form Inputs)

> **⚠️ NEVER use HTML form elements. ALL form inputs use `exp-form-field` with the `field` property (NOT `props`).**
>
> **⚠️⚠️ CRITICAL — #1 SILENT CRASH CAUSE: `exp-form-field` is the ONLY component that uses `field` instead of `props`.** If you accidentally use `props` instead of `field`, the ENTIRE PAGE goes blank — no content renders, no page name shows, and there are ZERO console errors. This is the hardest bug to diagnose because there is no error output at all. Always double-check that every `exp-form-field` node has `field: {...}` and NOT `props: {...}`.

```json
{
  "id": "__node_id_XXX",
  "name": "exp-form-field",
  "field": {
    "name": "__field_XXX",
    "type": "text",
    "label": "Field Label",
    "placeholder": "Enter value...",
    "[(value)]": "{%boundVariable%}",
    "visible": true,
    "disabled": false,
    "validation": [{"rule": "required", "message": "Required"}],
    "showErrorsOn": ["touched", "submit"],
    "block_classes": "col col-12 required",
    "classes": "",
    "label_classes": "",
    "suffix": "",
    "customFieldName": "",
    "excludeValueFromFormIfHidden": true,
    "_elementId": "__element_id_XXX",
    "events": {}
  },
  "_elementId": "__element_id_XXX"
}
```

**Field types:** `text`, `textarea`, `select`, `checkbox`, `radio`, `date`, `email`, `number`, `password`, `phone`, `file-upload`, `richtext`, `time`

**Validation rules:** `required` (`{rule, message}`), `pattern` (`{rule, value, message}`), `minLength` (`{rule, value, message}`). Ask the implementer what validations are needed.

**Select/Radio options** — use `labelKey` and `valueKey`:
```json
{
  "type": "select",
  "label": "Category",
  "[(value)]": "{%selectedCat%}",
  "labelKey": "name",
  "valueKey": "id",
  "[options]": "{%categoryList%}"
}
```
If API returns `[{"name": "USA", "id": "US"}]`, set `labelKey: "name"`, `valueKey: "id"`.

**Column sizing** via `block_classes`: `"col col-12"` (full), `"col col-6"` (half), `"col col-4"` (third), `"col col-3"` (quarter). Add `required` class when field has required validation.

### exp-form-builder (Dynamic Forms)

Generates forms from a JSON schema. Use when form fields come from config/API.

```json
{
  "name": "exp-form-builder",
  "props": {
    "[formConfig]": "{%myFormConfig%}",
    "showErrorsOn": ["touched", "submit"],
    "className": "form-container"
  },
  "events": {"action": [["this.formAction", "(function(data){ data.$api.setVariableValue('submitTrigger', Date.now()); })"]]}
}
```

The `formConfig` variable (auto-generated) contains `{form: {fields: [...], bindings: {}, action_buttons: [], container_classes: ""}}`. Each field in the array uses the same structure as standalone `exp-form-field.field`.

### exp-tabs-panel

> **⚠️ NEVER build custom tab UIs with buttons and visibility toggling.**

```json
{
  "name": "exp-tabs-panel",
  "props": {"className": "tabs-container"},
  "children": [
    {"name": "mat-tab", "props": {"label": "Tab 1"}, "children": [...]},
    {"name": "mat-tab", "props": {"label": "Tab 2"}, "children": [...]}
  ]
}
```

### exp-data-table

> **⚠️ NEVER use `<table>` HTML elements.**
> **⚠️ `exp-data-table` uses `props` (NOT `field`) and has NO `children` key.** Unlike `exp-form-field`, data tables use the standard `props` object. Never add a `children` array to `exp-data-table` — columns and cell templates are defined inside `props`.

**Static columns (recommended):**
```json
{
  "id": "__node_id_my_table",
  "name": "exp-data-table",
  "props": {
    "columns": [
      {"id": 1, "key": "name", "name": "Name", "type": "string", "sortable": true},
      {"id": 2, "key": "email", "name": "Email", "type": "string", "sortable": true},
      {"id": 3, "key": "status", "name": "Status", "type": "string", "sortable": false,
        "cellLayout": {"name": "div", "props": {"className": "badge", "innerHTML": "{%$item.status%}"}}}
    ],
    "[rowData]": "{%tableData%}",
    "hideHeader": false,
    "showFilters": true,
    "datasourceState": "success",
    "noItemsContent": "No records found"
  },
  "_elementId": "__element_id_my_table"
}
```

**Critical rules:**
- `datasourceState: "initial"` is REQUIRED
- Column `key` must exactly match row data property names (case-sensitive)
- For dynamic columns: use `[columns]` binding with NO `initialValue` on the variable (prevents `_columnCssClassName is not iterable` crash)

**cellLayout** — custom cell template with `{%$item.fieldName%}` binding:
```json
{"id": 2, "key": "status", "name": "Status", "type": "string", "sortable": false,
  "cellLayout": {"name": "div", "props": {"className": "badge", "innerHTML": "{%$item.status%}"}}}
```

**Row click:** `"events": {"rowClick": [["this.sel", "(function(data){ data.$api.setVariableValue('selected', data.$event); })"]]}`

### mat-accordion

> **⚠️ NEVER build custom collapsible panels.**
> **⚠️ `mat-expansion-panel-header` is NOT a valid PD component** — using it causes "Invalid declaration mat-expansion-panel-header" errors (16+ per page load). Place content directly inside `mat-expansion-panel`.

```json
{"name": "mat-accordion", "children": [
  {"name": "mat-expansion-panel", "children": [
    {"name": "div", "props": {"innerHTML": "Panel content goes here"}}
  ]}
]}
```

> **Note:** Accordion panels expand/collapse correctly via the built-in chevron. Header title text mechanism is limited — the `title` prop on `mat-expansion-panel` does not render visible header text. Content inside the panel body (form fields, buttons, etc.) renders correctly.

### exp-chart-card

```json
{"name": "exp-chart-card", "props": {
  "title": "Chart Title",
  "chart": {"type": "column", "source": "{%data%}", "responsive": true, "stacked": false,
    "xAxisLabel": "X", "yAxisLabel": "Y",
    "columnOptions": [{"key": "val", "label": "Value", "type": "bar"}],
    "colorsPalette": ["#2862F8"], "datasetsNumber": 1}
}}
```
Types: `column`, `line`, `pie`, `bar`, `doughnut`.

### exp-layout-dialog

```json
{"name": "exp-layout-dialog", "props": {"[visible]": "{%showDialog%}", "title": "Title"},
  "children": [
    {"name": "mat-dialog-content", "children": [{"name": "p", "props": {"innerHTML": "Body text"}}]},
    {"name": "mat-dialog-actions", "children": [
      {"name": "button", "props": {"innerHTML": "Cancel"}, "events": {"click": [["this.c", "(function(d){d.$api.setVariableValue('showDialog',false);})"]]}}
    ]}
  ]}
```

### Other Components

- **exp-loader**: `{"name": "exp-loader", "props": {"[isVisible]": "{%showLoader%}"}}`
- **wis-toast**: `{"name": "wis-toast", "props": {"[message]": "{%msg%}", "[type]": "{%type%}", "[visible]": "{%show%}"}}`
- **wis-breadcrumbs**: `{"name": "wis-breadcrumbs", "props": {"[items]": "{%items%}"}}`
- **wis-redirect**: `{"name": "wis-redirect", "props": {"[isVisible]": "{%shouldRedirect%}", "url": "/target"}}`
- **exp-svg-icon**: `{"name": "exp-svg-icon", "props": {"icon": "icon-name"}}` — use built-in first; only fall back to `exp-html-template` with SVG in `template` prop if icon not found.
- **exp-pagination-controls**: See `components/data-display/pagination-controls.json`.

### Responsive Grid (Multicolumn Container)

> **⚠️ ALWAYS use this grid system first. Only use custom CSS media queries if the grid cannot achieve the layout.**

PD has a built-in 12-column grid: `col col-12` (full), `col col-6` (half), `col col-4` (third), `col col-3` (quarter).
Use `block_classes` on form fields for column sizing. Use `Multicolumn Container` element for layout grids.

---

## Looping (Repeater)

> **⚠️ CRITICAL: `{%$item.fieldName%}` ONLY works inside `cellLayout` of `exp-data-table` columns.** Standalone `loop` on div nodes does NOT work — renders empty (0 children) and `{%$item.fieldName%}` causes "Can not determine data source" errors.

**Working pattern — cellLayout inside exp-data-table:**
```json
{"id": 2, "key": "status", "name": "Status", "type": "string", "sortable": false,
  "cellLayout": {"name": "div", "props": {"className": "badge", "innerHTML": "{%$item.status%}"}}}
```

**NOT working — standalone loop on div:**
```json
// ❌ DO NOT USE — renders empty, causes errors
{"loop": "{%items%}", "name": "div", "props": {"innerHTML": "{%$item.name%}"}}
```

**Alternatives for repeating content:**
- Use `exp-data-table` with `cellLayout` for list-like rendering
- Use derived variables to compute aggregated/formatted data for display in component property bindings

Context inside cellLayout: `{%$item%}` (current object), `{%$item.fieldName%}` (field), `{%$item.index%}` (zero-based index).

For 100+ items, use `exp-data-table` with pagination.

---

## HTTP Service Calls

```json
"httpRequests": {
  "generated": [],
  "userDefined": [{
    "meta": {"serviceCall": {"label": "Fetch Data", "callId": "sc-001", "serviceId": 1234, "inputState": [], "serviceUuid": "uuid-here"}},
    "handler": {
      "success": [["{%tableData%}", "get('$bodyJson.results')"]],
      "error": ["{%errorHandler%}"],
      "inProgress": "{%showLoader%}"
    },
    "request": {
      "url": "/rest/api/automation/chain/execute/uuid-here",
      "body": "{}",
      "method": "POST",
      "headers": {"Content-Type": "application/json"},
      "isAuthorized": true,
      "responseType": "json",
      "useExpressionCompiler": true
    },
    "trigger": ["this.onInit"],
    "triggerFilter": "function(data) {\r\n\treturn true;\r\n}",
    "responseTransformSpec": "(function(data){ \n\tconst response = data.$response;\n\tif(isExecutionFailed(response)) {\n\t\treturn convertResponseToADErrorResponse(response);\n\t}\n\treturn response;\n})"
  }]
}
```

**Key points:**
- `trigger: ["this.onInit"]` fires on page load — requires `onInit` Boolean variable in userDefined
- `trigger: ["this.varName"]` fires when variable changes
- `handler.success`: maps response to variables — `["{%var%}", "get('$bodyJson.key')"]`
- `handler.inProgress`: auto-sets Boolean to true/false during call
- Dynamic body: `"body": "{\"filter\": \"{%activeFilter%}\"}"` (with `useExpressionCompiler: true`)
- Multiple triggers: `"trigger": ["this.onInit", "this.refreshTrigger"]`
- **XML APIs**: use `responseType: "text"` — framework auto-converts XML to `$bodyJson`
- **`eventMeta` rule**: When adding/cloning HTTP requests, the `eventMeta` key in `meta.serviceCall` must ONLY be present for button/node-triggered calls (where a node event fires the call). For variable-triggered calls (`this.onInit`, `this.someVariable`), **omit `eventMeta` entirely** — do NOT set it to `{}`. An empty `eventMeta: {}` causes the PD UI to display "undefined - undefined" in the Call Trigger field.

**Initialization order:** Variables init → DOM renders → bindings evaluate → `onInit` triggers fire → responses arrive async. This is why dynamic `[columns]` with `initialValue` crashes — component constructs before data arrives.

### Service Call Checklist

1. **Response format** — JSON (`responseType: "json"`) or XML (`responseType: "text"`)?
2. **Columns** — static `columns` (recommended) or dynamic `[columns]` (no initialValue)?
3. **Key matching** — column `key` values match row data property names?
4. **Variables defined** — all handler targets exist in `variables.userDefined`?
5. **onInit variable** — included if using `trigger: ["this.onInit"]`?
6. **Test in Preview** — editor view doesn't execute service calls

---

## Figma-to-PD Conversion

> **⚠️ REMINDER: Map visual elements to PD components, NOT to HTML elements.**

**For all formats** (HTML/CSS export, Figma URL, screenshots):
1. Identify layout sections → map to `div` containers with `layout` prop (flex direction, gap, align)
2. **Map interactive elements to PD components** (see the table in the Critical Rule above)
3. Identify repeated elements → `exp-data-table` with `cellLayout` (standalone `loop` on divs does NOT work)
4. Replace static data with `{%variable%}` bindings
5. Ask developer about data sources and interactions

**CSS conversion:** Use `\r\n` for line breaks in `styles` string. Use `!important` for Angular Material overrides. No CSS Grid → use flexbox with `flex-basis: calc((100% / N) - (gap * (N-1) / N))` or Multicolumn Container.

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `ArrayNode cannot be cast to ObjectNode` | Array in `initialValue` | Remove or set to `null`; populate via service call |
| `_columnCssClassName is not iterable` | Dynamic `[columns]` variable has `initialValue` | Remove `initialValue`; columns must arrive from service call |
| Button invisible (renders as EXP-LAYOUT) | `[className]` dynamic binding on button | Use static `className` or derived variable |
| Table empty | Missing `datasourceState: "initial"`, or column key mismatch | Add `datasourceState`, verify keys match row data |
| Form field not updating | Missing two-way binding | Use `[(value)]` not `value` or `[value]` |
| Service call never fires | Missing trigger variable or wrong top-level key | Add `onInit` variable; use `httpRequests` not `http` |
| CSS not applied on buttons | Angular Material default styles | Add `!important` flag |
| `Invalid declaration undefined for mat-slide-toggle` | `mat-slide-toggle` is in editor Elements panel but has NO runtime declaration | Replace with `exp-form-field` type `checkbox`. NEVER use `mat-slide-toggle` directly |
| `Can not determine data source for expression: X` | Variable used in `loop` or binding doesn't exist in variables | Add the variable to `userDefined` or `derived`. For filtered lists, create a derived variable |
| `Can not determine data source for expression: $item.X` | `{%$item.fieldName%}` used outside `cellLayout` | Move to `cellLayout` inside `exp-data-table` column. `{%$item%}` ONLY works in cellLayout |
| Service call trigger shows "undefined - undefined" in PD UI | `eventMeta: {}` present on a variable-triggered service call | Remove `eventMeta` key entirely from `meta.serviceCall` for variable-triggered calls |
| 409 Conflict on page update | Page is locked by another user/session | Wait for the other editor to finish, or ask them to release the lock |
| `Invalid declaration mat-expansion-panel-header` (16+ errors) | `mat-expansion-panel-header` used as node name | Remove entirely — it is NOT a valid PD component. Place content directly in `mat-expansion-panel` children |
| `[innerHTML]` or `[textContent]` renders empty on div | Derived variable bound to div innerHTML/textContent | Derived variables can ONLY feed component property bindings (`[data]`, `[options]`, `[(value)]`, `[isVisible]`, etc.), NOT div content |
| Static `innerHTML` shows literal `{%var%}` text | Template expression used in static `innerHTML` string | Template expressions are NOT interpolated in static `innerHTML`. Use property bindings instead |
| 400 "Empty partial update flag passed" | `partialUpdate` field missing from save payload | Include `partialUpdate: false` (full) or `partialUpdate: true` (partial) in PUT body |
| 400 "Required request parameter 'pageLockAction'" | `pageLockAction` sent in request body | Use query parameter: `?pageLockAction=ACQUIRED` or `?pageLockAction=RELEASED` |
| Button click events silently fail | Event handlers on plain `<button>` elements may not fire | Button events may only work reliably on PD components or in certain contexts. Investigate alternative event binding approaches |
| Dialog children not rendering (0 children) | `exp-layout-dialog` with `[visible]` = false | Children are lazy-loaded — only created when dialog becomes visible via PD framework. DOM class manipulation does not trigger Angular change detection |
| Children render as empty comment nodes `<!---->` | `children` is an object `{0:..., 1:...}` instead of array `[...]` | **CRITICAL**: `children` MUST be JSON arrays. Convert all object-keyed children to proper arrays before saving. Use recursive fix function |
| `TypeError: Cannot read properties of undefined (reading 'length')` in chart template | `exp-chart-card` bound to empty/undefined `chartData` variable | Initialize `chartData` as empty array `[]`, or hide chart with `[isVisible]` until data loads |
| Variable referenced in binding causes "Can not determine data source" | Variable removed from `userDefined` but binding `{%varName%}` still exists in layout | Keep ALL variables in `userDefined` that are referenced anywhere in layout bindings, even if empty |
| `httpRequests.userDefined` service calls silently stripped on save | Service calls defined as named object keys `{getStudents: {...}}` | `httpRequests.userDefined` must be an array format, not an object. Structure needs further investigation |
| `exp-svg-icon` renders with no visible output | Unknown icon names or unavailable icon set | Icon names like "people", "school", "assessment" produce no errors but no visible icons. Available icon set is unknown — test in editor first |
| `exp-form-builder` shows nothing | `[formConfig]` bound to empty variable | Form builder requires a properly structured formConfig object. Use PD editor to generate the config, or provide it via service call |
| **Entire page blank — no page name, no content, no errors** | `layout` is `{children: [...]}` instead of a full root div node | `layout` MUST be a root node with `{id, name: "div", props: {layout: {...}}, children: [...], _elementId, unSelectable: true, __LAYOUT_CONFIG_METADATA: {}}`. See pd.json Structure section |
| **Entire page blank — silent crash, no errors** | `exp-form-field` using `props` instead of `field` | **CRITICAL**: `exp-form-field` uses `field` property, NOT `props`. Using `props` causes Angular to fail silently — entire page goes blank including page name. This is a complete page crash with zero console errors |
| NG0901 ngStyle errors on tab switch | Internal Angular Material issue with `exp-tabs-panel` | Non-blocking — page continues to function. 4 errors appear per tab switch. No fix needed, this is a framework issue |

---

## Styles

CSS as string: `"styles": ".my-class {\r\n\twidth: 100%;\r\n}"`. Use `\r\n` for newlines, `\t` for tabs, `var(--System-Blue, #2862F8)` for CSS variables, `!important` for Material overrides.

---

## Best Practices

1. **Always use PD components** — check `components/` directory first. Never create HTML equivalents.
2. Generate unique IDs: `__node_id_XXX_XXX`
3. Use flexbox layouts: `layout.type: "flex"` with direction/gap/alignment
4. Test incrementally in Preview mode
5. Ask about service calls before building
6. No arrays in initialValue
7. Simple variable references in bindings — complex logic in derived variables
8. Static `className` for buttons (no `[className]`)
9. `datasourceState: "initial"` on all `exp-data-table` components
10. Prefer static `columns` over dynamic `[columns]`
11. Use `Date.now()` for trigger variables to ensure unique values
12. Use `[(value)]` two-way binding on all form fields
13. Use `!important` for button styling overrides
14. Event handlers in loops get `$item` context
15. Defensive `triggerFilter` for cascading service calls: `data.varName !== null && data.varName !== undefined && data.varName !== ''`
16. **Every variable in `loop` bindings must exist** — if you use `loop: "{%filteredList%}"`, ensure `filteredList` is defined in `userDefined` or `derived`. Missing loop variables cause "Can not determine data source" errors
17. **Never use `mat-slide-toggle`** — despite appearing in the editor Elements panel, it has no runtime declaration. Use `exp-form-field` type `checkbox` instead
18. **Omit `eventMeta` on variable-triggered service calls** — only include `eventMeta` in `meta.serviceCall` for button/node-triggered calls. Empty `eventMeta: {}` causes "undefined - undefined" in the PD UI
19. **When removing nodes, also clean up** any variables or HTTP requests that are no longer referenced
20. **Always acquire lock before API updates** and release after — never skip the lock/unlock cycle
21. **Back up original config** before making any changes to existing pages
22. **Derived variables can ONLY feed component property bindings** — they work with `[data]`, `[options]`, `[(value)]`, `[isVisible]`, `[totalItems]`, etc. They CANNOT be displayed as text in div nodes via `innerHTML`, `[innerHTML]`, or `[textContent]`
23. **`{%$item%}` only works in `cellLayout`** — never use standalone `loop` on div nodes. Use `exp-data-table` with `cellLayout` for repeating content
24. **Never use `mat-expansion-panel-header`** — it is not a valid PD component. Place content directly inside `mat-expansion-panel`
25. **`partialUpdate` field is required** in all save API payloads — omitting it causes 400 error
26. **Lock API uses query parameters** — both ACQUIRED and RELEASED use `?pageLockAction=` query param, NOT request body
27. **Preview refresh button** (not browser F5) is needed after API save — the PD preview page has its own refresh mechanism to pick up new configuration
28. **`exp-tabs-panel` with `mat-tab` children is the most reliable multi-section pattern** — tabs render with proper Material styling, switching preserves content, nested components work correctly
29. **Service calls with multiple triggers work correctly** — `"trigger": ["this.onInit", "this.filterTrigger"]` fires independently on each variable change
30. **`exp-layout-dialog` children are lazy-loaded** — they only exist in DOM when `[visible]` is true. Don't attempt to manipulate dialog DOM when hidden
31. **CRITICAL: `children` MUST be JSON arrays** — never use objects with numeric keys `{0:..., 1:...}`. The PD framework only iterates over arrays. Objects cause wrapper divs to render with 0 children (empty comment nodes). Always use `children: [item1, item2, ...]`
32. **When building config via JavaScript, convert all children to arrays before saving** — use a recursive function: `if (!Array.isArray(node.children)) { node.children = Object.values(node.children); }`
33. **Never remove a variable that's still referenced in a layout binding** — if any node has `{%varName%}` in any prop, the variable must exist in `userDefined` even if empty. Removing it causes "Can not determine data source" errors
34. **Initialize chart data variables** — `exp-chart-card` throws repeated TypeErrors when its `source` variable is undefined. Set `initialValue` to `"[]"` or use `[isVisible]` to hide the chart until data loads
35. **`type: "phone"` on `exp-form-field` renders with 0 height** — use `type: "text"` with a phone placeholder instead
36. **`type: "radio"` on `exp-form-field` renders with 0 height without options data** — radio buttons require actual array data in `[options]` from a service call to render any UI
37. **Arrays for select/radio `[options]` and table `[data]` can ONLY come from service calls** — `initialValue`, derived variables, and static `options` props all fail to provide array data. Only `httpRequests` service call responses successfully populate array bindings
38. **`block_classes` column grid works WITHOUT parent flex layout** — `col col-6`, `col col-4`, `col col-3` etc. on form fields use a built-in grid system that breaks when the parent has `layout: {type: "flex"}`. Remove explicit flex layout from parent containers when using `block_classes`
39. **CRITICAL: `layout` must be a proper root div node** — never use `layout: {children: [...]}`. Always wrap in `{id, name: "div", props: {layout: {...}}, children: [...], _elementId, unSelectable: true, __LAYOUT_CONFIG_METADATA: {}}`. Missing root node = completely blank page
40. **CRITICAL: `exp-form-field` uses `field`, NOT `props`** — this is the #1 silent crash cause. `exp-form-field` is the ONLY component that uses `field` instead of `props`. All other components (exp-data-table, exp-tabs-panel, div, button, etc.) use `props`. Using `props` on `exp-form-field` crashes the entire page silently — no errors, no content, page name disappears
41. **`exp-data-table` uses `props` and has NO `children`** — columns, rowData, and all table config go inside `props`. Never add a `children` array. Cell templates use `cellLayout` inside column definitions
42. **`datasourceState: "success"` is preferred over `"initial"`** — tested working. Use `"success"` for tables with static/pre-loaded data. Use `"initial"` only when data arrives from a service call
43. **`wis-breadcrumbs` works with `[items]` binding** — bind to a variable containing array of `{label, url}` objects. Confirmed working for navigation hierarchies
44. **NG0901 ngStyle errors on tab switch are expected** — these Angular Material internal errors appear when switching tabs but don't affect functionality. Don't waste time debugging them

---

## API & Environments

**API base path:** `/rest/api/pagedesigner` (NOT `/rest/api/ui-designer/`)

**Environment:** Always ask the implementer which environment and base URL to use. Common patterns:
- Demo: `https://demo.expertly.cloud`
- QA: `https://client-XX.qa.expertly.cloud`
- Prod: `https://nonproduction-expertlyai.expertly.com`
- Local: `http://localhost:8080`

**Auth:** All API calls require `Authorization: Bearer {token}`. Ask the implementer for the token.

### Fetching Page Config

```bash
curl -s -X GET "${BASE_URL}/rest/api/pagedesigner/pages/${PAGE_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}"
```

The `configuration` field in the response is a **stringified JSON string** — parse it to get the pd.json object.

### Saving & Publishing

**Full update** (replace entire config):
```json
{"status": "DRAFT", "partialUpdate": false, "configuration": "<stringified pd.json>"}
```

> **⚠️ `partialUpdate` field is REQUIRED** in the save payload. Omitting it returns 400: "Empty partial update flag passed for page {pageId}". Use `false` for full updates, `true` for partial updates.

**Edit lock** — acquire before any update, release after. Both use **query parameters** (NOT request body):
```bash
# Acquire lock
curl -s -X PUT "${BASE_URL}/rest/api/pagedesigner/pages/lock/${PAGE_ID}?pageLockAction=ACQUIRED" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}"

# Release lock
curl -s -X PUT "${BASE_URL}/rest/api/pagedesigner/pages/lock/${PAGE_ID}?pageLockAction=RELEASED" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AUTH_TOKEN}"
```

> **⚠️ `pageLockAction` MUST be a query parameter.** Sending it in the request body returns 400: "Required request parameter 'pageLockAction' is not present". The PD editor auto-acquires the lock when open — you may need to release first, then acquire via API.

**Error handling:** 409 = page locked by another user, 401 = token expired/invalid.

**Publishing to production:** Must be done through the editor UI: Open page → Click Publish → Select host → Click "Publish and Deploy". Reload editor first if you saved config via API.

---

## Updating Existing Pages

When modifying an existing page (not creating from scratch), follow this workflow:

### Step 1: Fetch & Back Up

Fetch the current config via GET API. Save a backup copy before making any changes.

### Step 2: Choose Update Mode

**Full mode** (default) — for structural changes, adding/removing nodes, multi-section edits:
1. Deep-clone the current config
2. Apply all modifications to the clone
3. Validate: all node IDs unique, all variable bindings have matching definitions, all service call references valid
4. Acquire lock → PUT full config → Release lock

**Partial mode** — for small targeted changes (text updates, visibility toggles, prop changes):
1. Compute `PagePartialUpdate` operations instead of replacing the full config
2. Acquire lock → PUT partial operations → Release lock

### Partial Update Operations

Each operation has this shape:
```json
{"key": "layout.children[0].props.innerHTML", "value": "New Text", "operation": "UPDATE", "dataType": "STRING"}
```

**Fields:**
- `key` — Dot-notation path from config root. Array indices use `[n]`. Examples: `layout.props.className`, `layout.children[1].children[0].props.disabled`, `variables.userDefined`, `styles`, `httpRequests.userDefined`
- `value` — Always a string: strings as-is, numbers `"42"`, booleans `"true"`, arrays/objects JSON.stringify'd
- `operation` — `"CREATE"` (new fields) or `"UPDATE"` (existing)
- `dataType` — `"STRING"`, `"NUMBER"`, `"BOOLEAN"`, `"ARRAY"`, or `"OBJECT"`

**How to compute key paths** — walk the layout tree:
- Root layout: `layout`
- Root's first child: `layout.children[0]`
- That child's text: `layout.children[0].props.innerHTML`
- Nested child's class: `layout.children[0].children[1].props.className`

**Push partial updates:**
```json
{"status": "DRAFT", "partialUpdate": true, "pageElementOperations": [<operations array>]}
```

**Common update operations:**

| Change | Key Path Pattern | DataType |
|--------|-----------------|----------|
| Change text | `layout...props.innerHTML` | STRING |
| Toggle visibility | `layout...props.isVisible` | BOOLEAN |
| Change CSS classes | `layout...props.className` | STRING |
| Update table columns | `layout...props.columns` | ARRAY |
| Change button disabled | `layout...props.disabled` | BOOLEAN |
| Update variable value | `variables.userDefined[n].initialValue` | STRING/NUMBER/BOOLEAN |
| Update page CSS | `styles` | STRING |
| Replace children | `layout...children` | ARRAY |

**When to use partial:** Small, targeted changes; minimizing data transfer; large pages with few field changes.

**When NOT to use partial (use full):** Adding/removing entire nodes; changing interdependent parts (variables + layout + httpRequests); complex restructuring.

### Finding Nodes in Existing Config

Walk the `children` arrays recursively. Match by:
- `name` (component type, e.g., `"exp-data-table"`)
- `props.innerHTML` (text content)
- `id` (node ID, e.g., `"__node_id_XXX"`)
- `field.name` or `field.label` (form fields)

### Translation Updates

For partial updates with translations, use `/rest/api/pagedesigner/pages/phrases/{pageId}` instead of the standard endpoint.
