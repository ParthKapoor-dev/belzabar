# AGENTS.md — Browser Extension

## Purpose

This app is a browser extension content script for AD/PD web UIs. Current features:

1. Update page title with current method/page name
2. Trigger Run Test via keyboard shortcut (`Ctrl+Shift+Enter`) from anywhere on the page, including focused inputs/textareas
3. Provide a JSON modal editor to bulk edit AD test inputs and sync values back to DOM controls
4. Add a hover-revealed copy icon inside each output container to copy full output JSON and show toast feedback
5. Add hover-revealed overlay controls for native `<textarea>`: Open icon + Copy icon stacked at top-right (Open above Copy), with Open launching a large CodeMirror 6 editor modal (single editor surface) with line numbers, automatic lightweight syntax highlighting (Auto/SQL/SpEL/JS/JSON/plain), optional wrap mode (Wrap/No Wrap), and quick controls (language/wrap/font/copy). Overlay controls are injected via an extension-owned wrapper around each textarea for stable positioning.
6. Provide extension settings (button near `.header_banner` + `Ctrl+,`) to enable/disable features and manage persisted textarea editor defaults (language/wrap/font size)

## Tech and Runtime

1. Language: JavaScript (ES modules)
2. Manifest: MV3 (`manifest.json`)
3. Build: Bun bundling of `src/content-script.js` to `dist/content-script.js` with post-build non-ASCII escaping (`scripts/escape-non-ascii.mjs`) for extension loader compatibility
4. Target hosts: NSM dev/qa/uat, AD and PD paths

## Directory Map

1. `src/content-script.js` - app bootstrap
2. `src/config/` - selectors/constants
3. `src/core/` - shared state + logging + persisted settings
4. `src/features/title-updater/` - title logic + mutation observer
5. `src/features/keyboard/` - shortcut handler
6. `src/features/run-test/` - run button lookup + click
7. `src/features/json-editor/` - button injection, modal UI, input extraction, type handling, sync engine
8. `src/features/output-copy/` - output container copy-button injection + clipboard copy
9. `src/features/textarea-editor/` - textarea launcher injection + large modal editor
10. `src/features/settings/` - settings button/modal + keyboard shortcut
11. `src/ui/toast.js` - toast notifications
12. `src/ui/modal-lock.js` - page interaction lock while modal/dialog is open
13. `src/utils/dom.js` - DOM utility helpers

## Feature Flow

1. On load, extension reads persisted settings and enables only selected features.
2. JSON feature injects a `📋 JSON` button near the Inputs section.
3. Output copy feature injects a hover-revealed copy icon inside each `.output-container`.
4. Textarea editor feature injects hover-revealed overlay icons inside eligible native textareas (`Open` and `Copy` stacked on the top-right).
5. Open launches a large CodeMirror modal editor with line numbers and syntax highlighting (Auto/SQL/SpEL/JS/JSON/plain), plus language/wrap/font/copy controls, an in-editor button to open extension settings, and Save/Cancel actions.
6. Settings feature injects an icon-only `⚙` button near `.header_banner .page_title` and opens via `Ctrl+,`.
7. Settings toggles enable/disable title updater, run-test shortcut, JSON editor, output copy, and textarea editor in real time; settings also store textarea editor defaults (language/wrap/font size).
8. Modal loads detected inputs and current values into formatted JSON.
9. Sync path parses user JSON and writes values to AD controls with type-aware behavior.

## JSON Sync Engine (Current)

1. Extracts inputs from AD DOM using selector and container heuristics.
2. Normalizes value by target type:
   - Text, Number, Integer, Boolean, Date, DateTime, Json, Array, Map, StructuredData
3. Handles special controls:
   - boolean `exp-select`
   - date pickers (calendar navigation + model event synchronization)
   - structured-data textareas
4. Returns structured sync result:
   - success/failure
   - warnings/errors
   - counts and failed/missing keys

## Important Files for Agents

1. Bootstrap: `src/content-script.js`
2. Selectors/constants: `src/config/constants.js`
3. JSON extraction: `src/features/json-editor/extractor.js`
4. JSON sync implementation: `src/features/json-editor/sync.js`
5. JSON modal/UI actions: `src/features/json-editor/modal.js`
6. Injection logic: `src/features/json-editor/injector.js`
7. Output copy feature: `src/features/output-copy/index.js`
8. Textarea editor feature: `src/features/textarea-editor/index.js`
9. Textarea editor modal: `src/features/textarea-editor/modal.js`
10. Settings persistence: `src/core/settings.js`
11. Settings UI: `src/features/settings/index.js`, `src/features/settings/modal.js`

## Known Current Risks

1. DOM coupling is high; selectors depend on current AD/PD UI structure and class names.
2. Inline style-heavy modal implementation increases maintenance overhead.
3. Changes in datepicker/select control internals can break sync.
4. Console logging exists in bootstrap and JSON flows; keep this in mind for production noise.

## Safe Change Checklist

1. Validate behavior on both AD and PD pages after selector changes.
2. Test boolean/date/structured-data sync paths manually after editing `sync.js`.
3. Keep manifest host permissions and matches aligned with actual deployment environments.
4. Rebuild `dist/content-script.js` after code changes before shipping.

## Maintainer Agent Instructions

You are the Maintainer Agent. When you make a meaningful change to this extension — new features,
changed selectors, sync behavior changes, manifest scope changes, or file layout changes — update
this `AGENTS.md` in the same commit. Rebuild `dist/content-script.js` before shipping.
