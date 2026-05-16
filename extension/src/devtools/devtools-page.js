// Registers the "AD Network" panel in browser DevTools.
//
// This runs in the devtools-page context (one per open DevTools window). It
// only registers the panel; all logic lives in panel.js, which the browser
// loads when the user first opens the panel tab.
//
// The panel page is `panel.html` at the extension root (not under dist/):
// Chromium resolves this path relative to the extension root, but Firefox
// resolves it relative to the devtools page — a `dist/panel.html` would
// become `dist/dist/panel.html` there and the panel would load blank.
chrome.devtools.panels.create('AD Network', '', 'panel.html', () => {
  if (chrome.runtime && chrome.runtime.lastError) {
    console.error(
      '[AD Network] panel registration failed:',
      chrome.runtime.lastError
    );
  }
});
