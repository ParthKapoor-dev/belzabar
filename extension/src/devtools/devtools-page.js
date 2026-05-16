// Registers the "AD Chains" panel in Chrome DevTools.
chrome.devtools.panels.create(
  'AD Chains',
  '',
  'dist/panel.html',
  () => {
    /* panel created */
  }
);
