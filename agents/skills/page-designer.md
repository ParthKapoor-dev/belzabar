---
name: page-designer-cli
description: |
  Page Designer (PD) inspection and debugging workflow using the belz CLI. Use this skill when investigating PD page structure, variables, HTTP service calls, component trees, or validating configs for errors.
  MANDATORY TRIGGERS: PD page, page designer, belz pd, pd show, pd validate, page variables, HTTP calls, component tree, binding
---

# Page Designer CLI — Agent Investigation Guide

## What is a PD Page?

A PD page is a JSON configuration that renders an interactive UI. It contains:
- **Layout tree** — nested component hierarchy (divs, forms, tables, dialogs, symbols)
- **Variables** — user-defined (typed state) and derived (computed from dependencies)
- **HTTP service calls** — each triggers an AD method and maps results to variables
- **Bindings** — `{%variableName%}` syntax connects variables to component props and HTTP payloads

Components marked `isSymbol: true` are reusable sub-pages (like AD methods within methods).

## Investigation Workflow

### Step 1: Load the page overview
```bash
belz pd show <input> --llm
```
Accepts: PD URL, app URL, hex ID, or component name. Returns variable/HTTP/component counts.

### Step 2: Understand the variables
```bash
belz pd show <input> --vars --llm
```
Returns two tables:
- **User-defined** — name, type (Boolean, String, Any, KeyValue), initial value
- **Derived** — name, dependency list, side-effect flag

### Step 3: Inspect HTTP service calls
```bash
belz pd show <input> --http --llm
```
Returns: call label, AD method ID, HTTP method, trigger variables, output variable bindings.

### Step 4: See the component tree
```bash
belz pd show <input> --components --llm
```
Returns indented layout tree with `[symbol]` and `[events]` annotations.

### Step 5: Deep-dive into specifics
```bash
# Full variable detail (type, initial value, usage locations; or spec code for derived)
belz pd show <input> --var-detail <varName> --llm

# Full HTTP call detail (input bindings, success mappings, trigger filter, response transform code)
belz pd show <input> --http-detail <N> --llm    # N is 1-indexed
```

### Step 6: Validate for common errors
```bash
belz pd validate <input> --llm
```
Checks for 10 error patterns:
| Code | Severity | What it catches |
|------|----------|-----------------|
| ORPHAN_BINDING | error | `{%var%}` used but variable not defined |
| UNUSED_VARIABLE | warn | Variable defined but never referenced |
| FORM_FIELD_PROPS | error | `exp-form-field` with `props` instead of `field` (silent crash) |
| CHILDREN_NOT_ARRAY | error | `children` is object instead of array (empty render) |
| TABLE_NO_DATASOURCE | warn | `exp-data-table` missing `datasourceState` |
| INVALID_SLIDE_TOGGLE | error | `mat-slide-toggle` (no runtime declaration) |
| INVALID_EXPANSION_HEADER | error | `mat-expansion-panel-header` (invalid component) |
| MISSING_ONINIT_VAR | warn | HTTP trigger `onInit` but no onInit variable |
| EMPTY_EVENT_META | warn | `eventMeta: {}` shows "undefined - undefined" |
| DYNAMIC_COLS_INITIAL | warn | Dynamic `[columns]` + `initialValue` crash |

### Step 7: Search for pages/components
```bash
belz pd find "notice" --llm               # Fuzzy search by name
belz pd find list --llm                   # Browse all pages
belz pd find list --components --llm      # Browse all components
```

### Step 8: Trace AD method references
```bash
belz pd find-ad-methods <page-id> --recursive --llm
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| Dual-format config | Old pages use `context.properties` (tuples) + `http` (flat array). New pages use `variables.userDefined` (objects) + `httpRequests.userDefined`. The CLI handles both. |
| `{%var%}` binding | Variable reference in props, HTTP body, or handler mappings |
| Derived variable | Computed from dependencies. Has `spec` (transform code) and `from` (dependency list). Can have `sideEffect: true`. |
| Trigger | A variable name in an HTTP call's `trigger` array. When that variable changes, the HTTP call fires. |
| Symbol component | A reusable component (`isSymbol: true`). Appears in layout tree as `[symbol]`. Has its own config with variables and HTTP calls. |
| inProgressVar | Variable set while an HTTP call is in-flight (typically bound to a loader). |

## Common Debugging Patterns

**Page shows blank / doesn't render:**
→ Run `belz pd validate` — look for CHILDREN_NOT_ARRAY or FORM_FIELD_PROPS errors.

**Service call not firing:**
→ Check `--http-detail <N>` — verify trigger variables exist and are being set. Look for MISSING_ONINIT_VAR.

**Variable shows undefined:**
→ Check `--var-detail <name>` — verify it's defined. Check `--http` to see which call populates it.

**"undefined - undefined" in UI:**
→ Look for EMPTY_EVENT_META in `belz pd validate`.
