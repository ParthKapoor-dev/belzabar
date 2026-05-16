// "AD Chains" DevTools panel.
//
// Observes the network traffic DevTools already records, picks out Automation
// Designer chain *definition fetches*, reads the recorded response body, and
// lists each method by its human-readable name.

import {
  isChainFetchUrl,
  extractMethodNameFromChainResponse
} from '../features/chain-inspector/extract.js';

const MAX_ROWS = 200;
const SETTINGS_KEY = 'sdExtensionSettingsV1';

const rowsEl = document.getElementById('rows');
const countEl = document.getElementById('count');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const clearBtn = document.getElementById('clear');

let enabled = true;
let rowCount = 0;

function setStatus() {
  statusEl.textContent = enabled ? '' : 'disabled in extension settings';
}

// The panel runs in its own context and cannot read the page's localStorage
// directly — eval the `chainInspector` toggle inside the inspected window.
function refreshEnabled() {
  const expr =
    '(function(){try{return localStorage.getItem(' +
    JSON.stringify(SETTINGS_KEY) +
    ');}catch(e){return null;}})()';
  chrome.devtools.inspectedWindow.eval(expr, (result, isException) => {
    if (isException || typeof result !== 'string') {
      enabled = true;
    } else {
      try {
        const parsed = JSON.parse(result);
        enabled = !(parsed && parsed.chainInspector === false);
      } catch {
        enabled = true;
      }
    }
    setStatus();
  });
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta);
}

function addRow({ name, uuid, version, status }) {
  emptyEl.classList.add('hidden');

  const tr = document.createElement('tr');
  if (!name) tr.className = 'bad';

  const methodTd = document.createElement('td');
  methodTd.className = 'method';
  methodTd.textContent = name || '(name unavailable)';
  methodTd.title = name || '';

  const uuidTd = document.createElement('td');
  uuidTd.className = 'uuid';
  uuidTd.textContent = uuid.slice(0, 8) + '…';
  uuidTd.title = uuid + '  (click to copy)';
  uuidTd.addEventListener('click', () => {
    copyText(uuid);
    const prev = uuidTd.textContent;
    uuidTd.textContent = 'copied!';
    setTimeout(() => {
      uuidTd.textContent = prev;
    }, 900);
  });

  const apiTd = document.createElement('td');
  apiTd.textContent = version;

  const statusTd = document.createElement('td');
  statusTd.textContent = String(status);
  statusTd.className = status >= 200 && status < 300 ? 'status-ok' : 'status-err';

  const timeTd = document.createElement('td');
  timeTd.textContent = new Date().toLocaleTimeString();

  tr.append(methodTd, uuidTd, apiTd, statusTd, timeTd);
  rowsEl.insertBefore(tr, rowsEl.firstChild);

  rowCount += 1;
  while (rowsEl.childElementCount > MAX_ROWS) {
    rowsEl.removeChild(rowsEl.lastElementChild);
  }
  countEl.textContent = String(rowCount);
}

function handleRequest(request) {
  if (!enabled) return;
  const url = request && request.request && request.request.url;
  const match = isChainFetchUrl(url || '');
  if (!match) return;

  const status = (request.response && request.response.status) || 0;
  const version = /\/chain\/v2\//i.test(url) ? 'v2' : 'v1';

  request.getContent((body) => {
    addRow({
      name: extractMethodNameFromChainResponse(body || ''),
      uuid: match.uuid,
      version,
      status
    });
  });
}

clearBtn.addEventListener('click', () => {
  rowsEl.replaceChildren();
  rowCount = 0;
  countEl.textContent = '0';
  emptyEl.classList.remove('hidden');
});

chrome.devtools.network.onRequestFinished.addListener(handleRequest);
// Re-check the toggle whenever the user navigates the inspected page.
chrome.devtools.network.onNavigated.addListener(refreshEnabled);
refreshEnabled();
