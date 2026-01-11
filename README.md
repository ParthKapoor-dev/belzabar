# Method Title Updater

Browser extension that appends the automation designer method name to the page title.

## Format

Title becomes: `AD: <method-name>`

Example: `AD: vin.lookup`

## Installation

### Firefox
1. Open `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select `manifest.json`

### Chromium
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the extension folder

## Source

- `manifest.json` - Extension configuration
- `src/` - Source code organized in modules
- `dist/content-script.js` - Bundled content script (generated)
- `bunfig.toml` - Build configuration
- `package.json` - Metadata and scripts

## Development

1. Build: `bun run build` (bun handles dependencies automatically)
2. Load `dist/` folder as unpacked extension in browser
