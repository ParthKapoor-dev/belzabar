// Registers the "AD Network" panel in browser DevTools.
//
// This runs in the devtools-page context (one per open DevTools window). It
// only registers the panel; all logic lives in panel.js, which the browser
// loads when the user first opens the panel tab.
chrome.devtools.panels.create('AD Network', '', 'dist/panel.html', () => {
  /* panel registered */
});
