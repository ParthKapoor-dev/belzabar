// Background message relay for the PD Inspector DevTools panel.
//
// Firefox does not expose `chrome.tabs` to DevTools panel scripts (Chromium
// does). Without it the panel cannot message the page-side engine or open
// tabs, so its panel-pd.js calls would throw and leave the panel blank.
//
// This background script — reachable from both browsers via `chrome.runtime`
// messaging — relays those calls: the panel sends a `__pdRelay` message, and
// this forwards it to the inspected tab (or opens a tab).
//
// The same file is registered as a service worker (Chromium) and a classic
// background script (Firefox); a stateless relay behaves identically as both.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__pdRelay) return false;

  if (msg.__pdRelay === 'cmd') {
    // Forward a panel command to the engine content script in the inspected
    // tab. A missing engine surfaces as lastError -> null, which the panel
    // turns into its "reload the page" notice.
    try {
      chrome.tabs.sendMessage(msg.tabId, msg.payload, (resp) => {
        sendResponse(chrome.runtime.lastError ? null : resp);
      });
    } catch {
      sendResponse(null);
    }
    return true; // async response
  }

  if (msg.__pdRelay === 'open') {
    try {
      chrome.tabs.create({ url: msg.url });
    } catch {
      /* ignore */
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
