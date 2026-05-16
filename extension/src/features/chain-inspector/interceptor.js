// Chain Inspector — page (MAIN world) interceptor.
//
// Runs as a `world: "MAIN"` content script at document_start so it can wrap the
// page's own `fetch` / `XMLHttpRequest` (a content script in the isolated world
// cannot). It watches every AD "chain" request and forwards a compact record to
// the isolated-world HUD via `window.postMessage`. It never alters requests or
// responses — response bodies are only ever read from a clone.

import {
  classifyChainUrl,
  extractMethodNameFromChainResponse
} from './extract.js';

(() => {
  const MESSAGE_SOURCE = 'belz-chain-inspector';

  function post(info, status, name) {
    try {
      window.postMessage(
        {
          source: MESSAGE_SOURCE,
          uuid: info.uuid,
          kind: info.kind,
          version: info.version,
          status: typeof status === 'number' ? status : 0,
          name: name || null,
          at: Date.now()
        },
        '*'
      );
    } catch {
      /* ignore */
    }
  }

  // Pull a method name out of whatever an XHR exposes (responseText may throw
  // when responseType is "json"; fall back to the parsed `response`).
  function nameFromXhr(xhr) {
    let payload = null;
    try {
      payload = xhr.responseText;
    } catch {
      payload = null;
    }
    if (payload == null) {
      try {
        payload = xhr.response;
      } catch {
        payload = null;
      }
    }
    try {
      return extractMethodNameFromChainResponse(payload);
    } catch {
      return null;
    }
  }

  // ---- fetch ----------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      let url = '';
      try {
        const input = args[0];
        url = typeof input === 'string' ? input : (input && input.url) || '';
      } catch {
        url = '';
      }
      const info = url ? classifyChainUrl(url) : null;
      const result = origFetch.apply(this, args);
      if (info) {
        result
          .then((res) => {
            if (info.kind === 'fetch') {
              res
                .clone()
                .text()
                .then((body) =>
                  post(info, res.status, extractMethodNameFromChainResponse(body))
                )
                .catch(() => post(info, res.status, null));
            } else {
              post(info, res.status, null);
            }
          })
          .catch(() => post(info, 0, null));
      }
      return result;
    };
  }

  // ---- XMLHttpRequest -------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__belzChainUrl = typeof url === 'string' ? url : '';
      } catch {
        /* ignore */
      }
      return origOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...args) {
      let info = null;
      try {
        info = this.__belzChainUrl ? classifyChainUrl(this.__belzChainUrl) : null;
      } catch {
        info = null;
      }
      if (info) {
        this.addEventListener('load', () => {
          post(info, this.status, info.kind === 'fetch' ? nameFromXhr(this) : null);
        });
        this.addEventListener('error', () => post(info, 0, null));
      }
      return origSend.apply(this, args);
    };
  }
})();
