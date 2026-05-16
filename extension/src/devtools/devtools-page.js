// Registers the DevTools panels — "AD Network" and "PD Inspector".
//
// This runs in the devtools-page context (one per open DevTools window). It
// only registers the panels; all logic lives in panel.js / panel-pd.js, which
// the browser loads when the user first opens each panel tab.
//
// The panel pages (`panel.html`, `panel-pd.html`) live at the extension root
// (not under dist/): Chromium resolves these paths relative to the extension
// root, but Firefox resolves them relative to the devtools page — a
// `dist/panel.html` would become `dist/dist/panel.html` there and load blank.
chrome.devtools.panels.create('AD Network', '', 'panel.html', () => {
  if (chrome.runtime && chrome.runtime.lastError) {
    console.error(
      '[AD Network] panel registration failed:',
      chrome.runtime.lastError
    );
  }
});

chrome.devtools.panels.create('PD Inspector', '', 'panel-pd.html', () => {
  if (chrome.runtime && chrome.runtime.lastError) {
    console.error(
      '[PD Inspector] panel registration failed:',
      chrome.runtime.lastError
    );
  }
});
