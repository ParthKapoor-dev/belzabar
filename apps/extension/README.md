# Belzabar Extension

Browser extension (Chromium + Firefox/Zen, MV3) for the Automation Designer and Page Designer
web UIs.

## What it adds

- **AD Network DevTools panel** — chain requests with their method names.
- **PD Inspector DevTools panel** — component tree and on-page highlight for published pages.
- **Designer helpers** — method/page name in the tab title, `Ctrl+Shift+Enter` to run a test,
  a JSON editor for AD test inputs, copy buttons on outputs, a large code editor for textareas,
  and a settings modal (`Ctrl+,`) to switch each feature on or off.

## Install

The normal route is the CLI, which force-installs the signed release into your browsers:

```bash
belz extension load        # pick browsers interactively (or --all)
belz extension list        # what is installed where
```

## Develop

```bash
bun run build              # bundle src/ into dist/
node scripts/pack.mjs      # per-browser trees in build/chrome and build/firefox
```

Load the extension directory (Chromium: `chrome://extensions` → Developer mode → Load unpacked;
Firefox: `about:debugging` → Load Temporary Add-on → `manifest.json`). Releases are cut by
pushing an `ext-v<version>` tag. Maintainer notes: `AGENTS.md`.
