# Belzabar Extension

Browser extension for Service Designer automation tools that enhances the testing workflow.

## Features

### 📝 Title Updater
- Automatically appends the current method name to the page title
- Format: `Base Title – method.name`
- Helps identify which method you're currently working on

### ⌨️ Keyboard Shortcuts
- **Ctrl + Shift + Enter**: Trigger the "Run Test" button from anywhere on the page
- Works even when not focused on form elements
- Instant test execution without mouse navigation

### 📋 JSON Input Editor
- Click the "📋 JSON" button to open a modal editor
- Edit all input parameters as formatted JSON
- Real-time synchronization back to the form
- Type conversion (Text, Number, Boolean, JSON, etc.)
- Mandatory field indicators
- Input validation and error handling

## Example Usage

When working on a method called `vin.lookup`:
- Page title becomes: `Service Designer – vin.lookup`
- Press Ctrl+Shift+Enter to run tests instantly
- Click "📋 JSON" to bulk-edit all input parameters in a clean interface

## Installation

### Browser Extension Setup
1. Build the extension: `bun run build`
2. Load as unpacked extension in your browser:

#### Firefox
- Open `about:debugging`
- Click "This Firefox" → "Load Temporary Add-on"
- Select the extension folder

#### Chromium (Chrome/Edge)
- Open `chrome://extensions`
- Enable "Developer mode"
- Click "Load unpacked"
- Select the extension folder

### Target Environment
- Works on: `https://nsm-dev.nc.verifi.dev/automation-designer/*`
- Requires Service Designer interface to function

## Source

- `manifest.json` - Extension configuration
- `src/` - Source code organized in modules
- `dist/content-script.js` - Bundled content script (generated)
- `bunfig.toml` - Build configuration
- `package.json` - Metadata and scripts

## Development

1. Build: `bun run build` (bun handles dependencies automatically)
2. Load `dist/` folder as unpacked extension in browser
