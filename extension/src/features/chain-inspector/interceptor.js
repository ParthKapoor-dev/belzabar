// Chain Inspector — page (MAIN world) interceptor.
//
// Runs as a `world: "MAIN"` content script at document_start so it can wrap the
// page's own `fetch` / `XMLHttpRequest` (a content script in the isolated world
// cannot). It watches every AD "chain" request — in the designer *and* on
// published / public app pages — and forwards a compact record to the
// isolated-world HUD via `window.postMessage`. It never alters requests or
// responses; response bodies are only ever read from a clone.
//
// Because this runs at document_start but the HUD content script only attaches
// its listener at document_idle, every record is also kept in a small ring
// buffer and replayed when a HUD announces itself ("hello" handshake). That is
// what makes load-time chain requests visible instead of being silently lost.

import {
  classifyChainUrl,
  extractMethodNameFromChainResponse
} from './extract.js';

(() => {
  const MESSAGE_SOURCE = 'belz-chain-inspector';
  const HELLO_SOURCE = 'belz-chain-inspector-hello';
  const BUFFER_MAX = 250;

  const buffer = [];
  let seq = 0;

  function emit(record) {
    try {
      window.postMessage(record, '*');
    } catch {
      /* ignore */
    }
  }

  function post(info, status, name) {
    const record = {
      source: MESSAGE_SOURCE,
      seq: ++seq,
      uuid: info.uuid,
      kind: info.kind,
      version: info.version,
      status: typeof status === 'number' ? status : 0,
      name: name || null,
      at: Date.now()
    };
    buffer.push(record);
    if (buffer.length > BUFFER_MAX) buffer.shift();
    emit(record);
  }

  // A HUD attaches its listener long after document_start, so it misses every
  // record fired during page load. When it announces itself, replay the whole
  // buffer; the HUD de-duplicates by `seq`.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== HELLO_SOURCE) return;
    for (const record of buffer) emit(record);
  });

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
