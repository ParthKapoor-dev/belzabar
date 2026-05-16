// "AD Network" DevTools panel.
//
// A custom Network-tab-style panel scoped to Automation Designer "chain"
// requests. It reads the network traffic DevTools already records (no page
// overhead, no fetch/XHR patching) and adds what the real Network tab cannot:
// the human-readable AD method name and its service category.
//
// Name + category come from two sources:
//   - definition fetches  -> the name is in the recorded response body
//   - belz web            -> `belz ad show` (cache-backed) gives name + category

import {
  classifyChainUrl,
  extractMethodNameFromChainResponse
} from './extract.js';

const MAX_ROWS = 300;
const BELZ_WEB = 'http://localhost:65535';
const BELZ_DEBOUNCE_MS = 250;
const BELZ_RETRY_MS = 4000;

// ---- DOM ------------------------------------------------------------------
const recordBtn = document.getElementById('record');
const clearBtn = document.getElementById('clear');
const preserveBox = document.getElementById('preserve');
const filterInput = document.getElementById('filter');
const countEl = document.getElementById('count');
const offlineEl = document.getElementById('offline');
const listPane = document.querySelector('.list-pane');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const detailEl = document.getElementById('detail');
const detailBody = document.getElementById('detail-body');
const detailClose = document.getElementById('detail-close');
const detailCopy = document.getElementById('detail-copy');
const detailTabs = Array.from(document.querySelectorAll('.detail-tabs button'));
const toastEl = document.getElementById('toast');

// ---- state ----------------------------------------------------------------
const entries = []; // chronological (oldest-first), mirrors DOM order
const uuidToName = new Map();
const uuidToCategory = new Map();
let nextId = 1;
let recording = true;
let preserveLog = false;
let filterText = '';
let selectedId = null;
let activeTab = 'headers';
let currentEnv = 'nsm-dev';
let currentCopyText = '';

const pendingUuids = new Set();
let belzTimer = null;
let belzRetryTimer = null;

// "Open in draft" queue — processed one at a time.
const openQueue = [];
let openProcessing = false;

// ---- env detection --------------------------------------------------------
function envFromHost(host) {
  if (typeof host !== 'string') return 'nsm-dev';
  const m = host.match(/^(nsm-(?:dev|qa|uat))(?:-public)?\./i);
  return m ? m[1].toLowerCase() : 'nsm-dev';
}

function detectEnv() {
  try {
    chrome.devtools.inspectedWindow.eval('location.hostname', (result) => {
      currentEnv = envFromHost(result);
    });
  } catch {
    /* keep previous env */
  }
}

// ---- small helpers --------------------------------------------------------
function formatBytes(n) {
  if (typeof n !== 'number' || n < 0 || !isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' kB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function typeOf(har) {
  if (har._resourceType) return har._resourceType;
  const mime =
    har.response && har.response.content && har.response.content.mimeType;
  if (typeof mime === 'string' && mime) return mime.split(';')[0];
  return '—';
}

function transferSize(har) {
  const r = har.response || {};
  if (typeof r._transferSize === 'number' && r._transferSize >= 0) {
    return r._transferSize;
  }
  if (typeof r.bodySize === 'number' && r.bodySize >= 0) return r.bodySize;
  const c = r.content || {};
  if (typeof c.size === 'number' && c.size >= 0) return c.size;
  return -1;
}

// Group an HTTP status into a colour bucket (#9).
function statusGroup(status) {
  if (!status) return 'pending';
  if (status >= 500) return 'srverr';
  if (status >= 400) return 'clienterr';
  if (status >= 300) return 'redir';
  if (status >= 200) return 'ok';
  return 'pending';
}

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  for (const k of kids) {
    if (k == null) continue;
    node.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return node;
}

let toastTimer = null;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

// ---- row action buttons ---------------------------------------------------
const ICON_COPY =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/>' +
  '<path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_OPEN =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M11 13 20 4"/>' +
  '<path d="M19 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>';

function iconButton(svg, title, handler) {
  const b = document.createElement('button');
  b.className = 'act';
  b.type = 'button';
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    handler(b);
  });
  return b;
}

function flashOk(btn) {
  btn.classList.add('ok');
  setTimeout(() => btn.classList.remove('ok'), 700);
}

// Build a copy-pasteable cURL command from a captured request.
function buildCurl(har) {
  const req = (har && har.request) || {};
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const parts = ['curl ' + q(req.url || '')];
  if (req.method && req.method.toUpperCase() !== 'GET') {
    parts.push('-X ' + req.method.toUpperCase());
  }
  for (const h of req.headers || []) {
    if (!h || !h.name || h.name.charAt(0) === ':') continue;
    parts.push('-H ' + q(h.name + ': ' + (h.value || '')));
  }
  const bodyText = req.postData && req.postData.text;
  if (bodyText) parts.push('--data-raw ' + q(bodyText));
  return parts.join(' \\\n  ');
}

// ---- "open in draft" queue (#3, #11) --------------------------------------
// Opens the method's draft designer page, with inputs autofilled, in a
// BACKGROUND tab — the user stays on the page they are already on.
function openTab(url) {
  try {
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url, active: false });
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  try {
    window.open(url, '_blank');
  } catch {
    /* ignore */
  }
}

function enqueueOpen(entry) {
  openQueue.push(entry);
  showToast(
    'queued ' +
      (uuidToName.get(entry.uuid) || entry.uuid.slice(0, 8) + '…') +
      ' · ' +
      openQueue.length +
      ' in queue'
  );
  processOpenQueue();
}

async function processOpenQueue() {
  if (openProcessing) return;
  const entry = openQueue.shift();
  if (!entry) return;
  openProcessing = true;
  try {
    const res = await fetch(BELZ_WEB + '/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: entry.uuid, env: currentEnv })
    });
    const data = await res.json();
    if (!res.ok || !data.resolved || typeof data.editUrl !== 'string') {
      throw new Error((data && (data.reason || data.error)) || 'resolve failed');
    }
    setOffline(false);
    const req = entry.har && entry.har.request;
    const body = (req && req.postData && req.postData.text) || '';
    let url = data.editUrl;
    if (body) {
      try {
        url +=
          (url.includes('?') ? '&' : '?') +
          '_belz_autofill=' +
          encodeURIComponent(btoa(body));
      } catch {
        /* body not Latin1 — open without autofill */
      }
    }
    openTab(url);
    const remaining = openQueue.length;
    showToast(
      'opening ' +
        (data.name || entry.uuid.slice(0, 8) + '…') +
        ' in draft mode' +
        (remaining ? ' · ' + remaining + ' queued' : '')
    );
  } catch (err) {
    setOffline(true);
    showToast(
      'could not open ' +
        entry.uuid.slice(0, 8) +
        '… — ' +
        (err && err.message ? err.message : 'belz web error')
    );
  } finally {
    openProcessing = false;
    if (openQueue.length) setTimeout(processOpenQueue, 150);
  }
}

// ---- name / category resolution -------------------------------------------
function learnName(uuid, name) {
  if (!uuid || !name || uuidToName.get(uuid) === name) return;
  uuidToName.set(uuid, name);
  for (const entry of entries) {
    if (entry.uuid === uuid) paintName(entry);
  }
  reRenderDetailIf(uuid);
}

function learnCategory(uuid, category) {
  if (!uuid || !category || uuidToCategory.get(uuid) === category) return;
  uuidToCategory.set(uuid, category);
  for (const entry of entries) {
    if (entry.uuid === uuid) paintCategory(entry);
  }
  reRenderDetailIf(uuid);
}

function reRenderDetailIf(uuid) {
  if (selectedId == null || activeTab !== 'headers') return;
  const sel = entries.find((e) => e.id === selectedId);
  if (sel && sel.uuid === uuid) renderDetail();
}

function paintName(entry) {
  const name = uuidToName.get(entry.uuid);
  entry.nameCell.className = 'name s-' + entry.statusGroup + (name ? '' : ' pending');
  entry.nameCell.textContent = name || entry.uuid.slice(0, 12) + '…';
  entry.nameCell.title = name
    ? name + '  ·  click to open in draft'
    : entry.uuid + '  (resolving…)';
}

function paintCategory(entry) {
  const cat = uuidToCategory.get(entry.uuid);
  entry.categoryCell.className = cat ? 'category' : 'category pending';
  entry.categoryCell.textContent = cat || '…';
  entry.categoryCell.title = cat ? cat + '  ·  click to open in draft' : '';
}

function setOffline(off) {
  offlineEl.classList.toggle('hidden', !off);
}

function needsBelz(uuid) {
  return !uuidToName.has(uuid) || !uuidToCategory.has(uuid);
}

function scheduleBelzFetch() {
  if (belzTimer) return;
  belzTimer = setTimeout(() => {
    belzTimer = null;
    flushBelzFetch();
  }, BELZ_DEBOUNCE_MS);
}

async function flushBelzFetch() {
  const uuids = [];
  for (const uuid of pendingUuids) {
    if (needsBelz(uuid)) uuids.push(uuid);
  }
  pendingUuids.clear();
  if (uuids.length === 0) return;

  try {
    const res = await fetch(BELZ_WEB + '/api/ad-names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuids, env: currentEnv })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    setOffline(false);
    const items = (data && data.items) || {};
    for (const uuid of Object.keys(items)) {
      const meta = items[uuid];
      if (!meta) continue;
      if (meta.name) learnName(uuid, meta.name);
      if (meta.category) learnCategory(uuid, meta.category);
    }
  } catch {
    setOffline(true);
    // belz web is commonly started after the panel is already open — keep the
    // uuids queued and retry on a timer so they fill in once it is up.
    for (const uuid of uuids) {
      if (needsBelz(uuid)) pendingUuids.add(uuid);
    }
    if (pendingUuids.size > 0 && !belzRetryTimer) {
      belzRetryTimer = setTimeout(() => {
        belzRetryTimer = null;
        flushBelzFetch();
      }, BELZ_RETRY_MS);
    }
  }
}

// ---- request capture ------------------------------------------------------
function onRequest(har) {
  if (!recording) return;
  const req = har && har.request;
  const info = req ? classifyChainUrl(req.url) : null;
  if (!info) return;

  const status = (har.response && har.response.status) || 0;
  const entry = {
    id: nextId++,
    uuid: info.uuid,
    kind: info.kind,
    version: info.version,
    httpMethod: req.method || '—',
    url: req.url,
    status,
    statusGroup: statusGroup(status),
    type: typeOf(har),
    size: transferSize(har),
    time: typeof har.time === 'number' ? har.time : -1,
    har,
    rowEl: null,
    nameCell: null,
    categoryCell: null
  };

  // Follow the tail like the real Network tab if already scrolled to bottom.
  const atBottom =
    listPane.scrollTop + listPane.clientHeight >= listPane.scrollHeight - 4;

  entries.push(entry);
  renderRow(entry);

  if (atBottom) listPane.scrollTop = listPane.scrollHeight;

  // Name: definition fetches carry it in their body — read it instantly.
  if (info.kind === 'fetch') {
    har.getContent((body) => {
      const name = extractMethodNameFromChainResponse(body || '');
      if (name) learnName(info.uuid, name);
    });
  }
  // Name (for execute) + category for every row come from belz web.
  if (needsBelz(info.uuid)) {
    pendingUuids.add(info.uuid);
    scheduleBelzFetch();
  }

  // Cap the table — drop the oldest rows.
  while (entries.length > MAX_ROWS) {
    const old = entries.shift();
    if (old && old.rowEl && old.rowEl.parentNode) old.rowEl.remove();
    if (old && old.id === selectedId) closeDetail();
  }
  countEl.textContent = String(entries.length);
}

function renderRow(entry) {
  emptyEl.classList.add('hidden');

  const srCell = el('td', { className: 'sr' }, String(entry.id));

  const nameCell = el('td', null);
  const categoryCell = el('td', null);
  entry.nameCell = nameCell;
  entry.categoryCell = categoryCell;
  // Clicking the name or category opens the method in draft (#6).
  const openFromCell = (e) => {
    e.stopPropagation();
    enqueueOpen(entry);
  };
  nameCell.addEventListener('click', openFromCell);
  categoryCell.addEventListener('click', openFromCell);

  const copyCurlBtn = iconButton(ICON_COPY, 'Copy as cURL', (btn) => {
    try {
      navigator.clipboard.writeText(buildCurl(entry.har));
      flashOk(btn);
    } catch {
      /* ignore */
    }
  });
  const openBtn = iconButton(
    ICON_OPEN,
    'Open in draft mode (background tab)',
    (btn) => {
      enqueueOpen(entry);
      flashOk(btn);
    }
  );
  const actionsCell = el('td', { className: 'actions' }, copyCurlBtn, openBtn);

  const statusBadge = el(
    'span',
    { className: 'sbadge ' + entry.statusGroup },
    entry.status ? String(entry.status) : '—'
  );
  const statusCell = el('td', null, statusBadge);

  const httpCell = el('td', { className: 'dim' }, entry.httpMethod);

  const badge = el(
    'span',
    { className: 'badge ' + (entry.kind === 'execute' ? 'run' : 'get') },
    entry.kind === 'execute' ? 'RUN' : 'GET'
  );
  const kindCell = el('td', { className: 'dim' }, badge, ' ' + entry.version);

  const idCell = el(
    'td',
    { className: 'mono', title: entry.uuid + '  ·  click to copy' },
    entry.uuid
  );
  idCell.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(entry.uuid);
    } catch {
      /* ignore */
    }
    const prev = idCell.textContent;
    idCell.textContent = 'copied';
    setTimeout(() => {
      idCell.textContent = prev;
    }, 700);
  });

  const typeCell = el('td', { className: 'dim' }, entry.type);
  const sizeCell = el('td', { className: 'dim' }, formatBytes(entry.size));
  const timeCell = el(
    'td',
    { className: 'dim' },
    entry.time >= 0 ? Math.round(entry.time) + ' ms' : '—'
  );

  const row = el(
    'tr',
    null,
    srCell,
    nameCell,
    categoryCell,
    actionsCell,
    statusCell,
    httpCell,
    kindCell,
    idCell,
    typeCell,
    sizeCell,
    timeCell
  );
  row.addEventListener('click', () => selectEntry(entry));

  entry.rowEl = row;
  paintName(entry);
  paintCategory(entry);
  applyRowFilter(entry);

  rowsEl.appendChild(row);
}

// ---- filter ---------------------------------------------------------------
function rowMatches(entry) {
  if (!filterText) return true;
  const name = (uuidToName.get(entry.uuid) || '').toLowerCase();
  const cat = (uuidToCategory.get(entry.uuid) || '').toLowerCase();
  return (
    name.includes(filterText) ||
    cat.includes(filterText) ||
    entry.uuid.includes(filterText) ||
    entry.url.toLowerCase().includes(filterText)
  );
}

function applyRowFilter(entry) {
  if (entry.rowEl) entry.rowEl.classList.toggle('hidden', !rowMatches(entry));
}

function applyFilter() {
  for (const entry of entries) applyRowFilter(entry);
}

// ---- detail pane ----------------------------------------------------------
function selectEntry(entry) {
  selectedId = entry.id;
  for (const e of entries) {
    if (e.rowEl) e.rowEl.classList.toggle('selected', e.id === entry.id);
  }
  detailEl.classList.remove('hidden');
  renderDetail();
}

function closeDetail() {
  selectedId = null;
  detailEl.classList.add('hidden');
  for (const e of entries) {
    if (e.rowEl) e.rowEl.classList.remove('selected');
  }
}

function kvGrid(pairs) {
  const grid = el('div', { className: 'kv' });
  for (const [k, v] of pairs) {
    grid.append(
      el('div', { className: 'k' }, k),
      el('div', { className: 'v' }, v == null || v === '' ? '—' : String(v))
    );
  }
  return grid;
}

function headerRows(headers) {
  return Array.isArray(headers) ? headers.map((h) => [h.name, h.value]) : [];
}

function headersToObj(headers) {
  const o = {};
  for (const h of headers || []) {
    if (h && h.name) o[h.name] = h.value;
  }
  return o;
}

function prettyMaybeJson(text) {
  if (typeof text !== 'string' || !text.trim()) return text || '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function renderDetail() {
  const entry = entries.find((e) => e.id === selectedId);
  if (!entry) return;
  detailBody.replaceChildren();
  currentCopyText = '';
  const har = entry.har;

  if (activeTab === 'headers') {
    const name = uuidToName.get(entry.uuid);
    const category = uuidToCategory.get(entry.uuid);
    detailBody.append(
      el('h4', null, 'General'),
      kvGrid([
        ['Method name', name || '(resolving…)'],
        ['Category', category || '(resolving…)'],
        ['UUID', entry.uuid],
        ['Chain kind', entry.kind + ' (' + entry.version + ')'],
        ['Request URL', entry.url],
        ['HTTP method', entry.httpMethod],
        ['Status', entry.status || '—'],
        ['Env', currentEnv]
      ]),
      el('h4', null, 'Request headers'),
      kvGrid(headerRows(har.request && har.request.headers)),
      el('h4', null, 'Response headers'),
      kvGrid(headerRows(har.response && har.response.headers))
    );
    currentCopyText = JSON.stringify(
      {
        general: {
          methodName: name || null,
          category: category || null,
          uuid: entry.uuid,
          chainKind: entry.kind + ' ' + entry.version,
          requestUrl: entry.url,
          httpMethod: entry.httpMethod,
          status: entry.status || null,
          env: currentEnv
        },
        requestHeaders: headersToObj(har.request && har.request.headers),
        responseHeaders: headersToObj(har.response && har.response.headers)
      },
      null,
      2
    );
  } else if (activeTab === 'payload') {
    const post = har.request && har.request.postData;
    const query = har.request && har.request.queryString;
    if (post && typeof post.text === 'string' && post.text) {
      const pretty = prettyMaybeJson(post.text);
      detailBody.append(
        el('h4', null, 'Request payload'),
        el('pre', null, pretty)
      );
      currentCopyText = pretty;
    }
    if (Array.isArray(query) && query.length) {
      detailBody.append(
        el('h4', null, 'Query string'),
        kvGrid(query.map((q) => [q.name, q.value]))
      );
      if (!currentCopyText) {
        const o = {};
        for (const q of query) o[q.name] = q.value;
        currentCopyText = JSON.stringify(o, null, 2);
      }
    }
    if (!detailBody.childNodes.length) {
      detailBody.append(el('pre', null, 'No request payload.'));
    }
  } else if (activeTab === 'response') {
    detailBody.append(el('pre', null, 'Loading response…'));
    const token = entry.id;
    har.getContent((body) => {
      if (selectedId !== token || activeTab !== 'response') return;
      const pretty = body ? prettyMaybeJson(body) : '(empty)';
      currentCopyText = body ? pretty : '';
      detailBody.replaceChildren(
        el('h4', null, 'Response body'),
        el('pre', null, pretty)
      );
    });
  } else if (activeTab === 'timing') {
    const t = har.timings || {};
    const rows = [['Total', Math.round(har.time || 0) + ' ms']];
    const obj = { total: Math.round(har.time || 0) };
    for (const key of ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive']) {
      if (typeof t[key] === 'number' && t[key] >= 0) {
        rows.push([key, Math.round(t[key]) + ' ms']);
        obj[key] = Math.round(t[key]);
      }
    }
    detailBody.append(el('h4', null, 'Timing'), kvGrid(rows));
    currentCopyText = JSON.stringify(obj, null, 2);
  }
}

// ---- clearing -------------------------------------------------------------
function clearAll() {
  entries.length = 0;
  rowsEl.replaceChildren();
  countEl.textContent = '0';
  emptyEl.classList.remove('hidden');
  closeDetail();
}

// ---- wiring ---------------------------------------------------------------
recordBtn.addEventListener('click', () => {
  recording = !recording;
  recordBtn.classList.toggle('on', recording);
  recordBtn.querySelector('.dot').nextSibling.textContent = recording
    ? ' Recording'
    : ' Paused';
});

clearBtn.addEventListener('click', clearAll);

preserveBox.addEventListener('change', () => {
  preserveLog = preserveBox.checked;
});

filterInput.addEventListener('input', () => {
  filterText = filterInput.value.trim().toLowerCase();
  applyFilter();
});

detailClose.addEventListener('click', closeDetail);

// Copy just the active tab's content — the JSON/body, no section headings (#2).
detailCopy.addEventListener('click', () => {
  try {
    navigator.clipboard.writeText(currentCopyText || '');
    detailCopy.classList.add('ok');
    detailCopy.textContent = 'Copied';
    setTimeout(() => {
      detailCopy.classList.remove('ok');
      detailCopy.textContent = 'Copy';
    }, 900);
  } catch {
    /* ignore */
  }
});

// Arrow-key navigation across visible rows.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  const visible = entries.filter(
    (en) => en.rowEl && !en.rowEl.classList.contains('hidden')
  );
  if (visible.length === 0) return;
  e.preventDefault();
  let idx = visible.findIndex((en) => en.id === selectedId);
  if (e.key === 'ArrowDown') {
    idx = idx < 0 ? 0 : Math.min(idx + 1, visible.length - 1);
  } else {
    idx = idx < 0 ? 0 : Math.max(idx - 1, 0);
  }
  const target = visible[idx];
  if (target) {
    selectEntry(target);
    if (target.rowEl) target.rowEl.scrollIntoView({ block: 'nearest' });
  }
});

for (const tab of detailTabs) {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    for (const t of detailTabs) t.classList.toggle('active', t === tab);
    renderDetail();
  });
}

chrome.devtools.network.onRequestFinished.addListener(onRequest);
chrome.devtools.network.onNavigated.addListener(() => {
  detectEnv();
  if (!preserveLog) clearAll();
});

detectEnv();
