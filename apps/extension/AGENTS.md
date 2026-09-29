# AGENTS.md — Browser Extension (`apps/extension`)

## Purpose

`belzabar-extension` is an MV3 browser extension (plain JavaScript, ES modules) for the
Automation Designer / Page Designer web UIs, for Chromium and Firefox (incl. Zen). It has three
parts:

1. **Content scripts** on the designers: `src/ad-content.js` (`/automation-designer/*`) and
   `src/pd-content.js` (`/ui-designer/*`). Both call `src/core/bootstrap.js` with their feature
   set; features are toggled from the settings modal and persisted (`src/core/settings.js`).
2. **DevTools panels** (`devtools.html` → `src/devtools/devtools-page.js`):
   - **AD Network** (`panel.html`, `src/devtools/panel.js`): a Network-tab-style list of AD chain
     requests with the method name. Standalone: names are learned from definition responses in
     the recorded traffic; execute-only uuids show the raw uuid. (It no longer calls a local
     belz web dashboard, which was removed; there are no localhost permissions.)
   - **PD Inspector** (`panel-pd.html`, `src/devtools/panel-pd.js`): component tree + on-page
     highlight for published `/pages/*`, talking to the `src/pd-inspector.js` content script
     through the `src/background.js` relay (Firefox panels have no `chrome.tabs`).
3. **Background relay** `src/background.js` (service worker on Chromium, script on Firefox).

Hosts: `manifest.json` lists the NSM (dev/qa/uat, staff-nss), YieldSec and Expertly hosts; keep
`host_permissions` and every `content_scripts.matches` list aligned.

## Features (AD unless noted)

| Feature | Files | Notes |
|---------|-------|-------|
| Title updater (AD+PD) | `src/features/title-updater/index.js` | appends method/page name to the tab title |
| Run-test shortcut (AD+PD) | `src/features/keyboard/shortcuts.js`, `src/features/run-test/` | `Ctrl+Shift+Enter`, works inside inputs |
| JSON input editor | `src/features/json-editor/` (`extractor`, `sync`, `modal`, `injector`, `types`) | bulk-edit test inputs; type-aware sync incl. boolean `exp-select`, date pickers, structured-data textareas |
| Output copy (AD+PD) | `src/features/output-copy/index.js` | hover copy icon per `.output-container` |
| Textarea editor (AD+PD) | `src/features/textarea-editor/` | Open/Copy overlay on native textareas; CodeMirror 6 modal (Auto/SQL/SpEL/JS/JSON/plain, wrap, font) |
| Settings (AD+PD) | `src/features/settings/`, `src/core/settings.js` | `⚙` button near `.header_banner`, `Ctrl+,` |
| Curl autofill | `src/features/curl-autofill/index.js` | AD only; fills test inputs from the `_belz_autofill` URL param |
| PD inspector | `src/features/pd-inspector/` (see its `HOW-IT-WORKS.md`), `src/pd-inspector.js` | published pages only |

Shared: `src/config/constants.js` (selectors), `src/core/` (bootstrap, state, logger, observer,
settings), `src/ui/` (toast, modal, modal-lock, styles, theme from `@belzabar/design`),
`src/utils/` (dom, clipboard).

## Build, pack, release

- `bun run build` (`scripts/build.mjs`) bundles each entry flat into `dist/` (gitignored) and runs
  `scripts/escape-non-ascii.mjs` on each output (extension loaders reject some non-ASCII).
  `bun run dev` watches the main entries.
- `node scripts/pack.mjs [--version X.Y.Z]` builds, then assembles loadable per-browser trees in
  `build/chrome` and `build/firefox` (gitignored), using `release.config.json` for the Firefox id
  and update URLs.
- Release: push a tag `ext-v<version>`; `.github/workflows/extension-release.yml` packs a signed
  CRX, signs the XPI via AMO, and publishes the update manifests to GitHub Pages.
- Install for users: `belz extension load` writes each browser's enterprise force-install policy
  (see `packages/core/src/browsers.ts`); `belz extension list` / `belz extension remove`.
- Local dev: load the extension directory unpacked after `bun run build`.

## Risks / checklist

1. DOM coupling is high — selectors depend on the AD/PD UI's class names. After a selector
   change, check both AD and PD pages.
2. After editing `src/features/json-editor/sync.js`, manually test boolean, date and
   structured-data sync.
3. There are no automated tests for the extension; `bun run check` does not cover it.

## Maintainer Agent Instructions

When you change features, selectors, sync behaviour, manifest scope or file layout, update this
`AGENTS.md` (and `README.md` if user-facing) in the same commit.
