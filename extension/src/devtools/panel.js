// "AD Network" DevTools panel.
//
// A custom Network-tab-style panel scoped to Automation Designer "chain"
// requests. It reads the network traffic DevTools already records (no page
// overhead, no fetch/XHR patching) and adds the one column the real Network
// tab cannot: the human-readable AD method name.
//
// Names come from two sources:
//   - definition fetches  -> the name is in the recorded response body
//   - execute calls       -> resolved via the local `belz web` server, which
//                            looks them up through the cache-backed `belz ad show`

import {
  classifyChainUrl,
  extractMethodNameFromChainResponse
} from './extract.js';

const MAX_ROWS = 300;
const BELZ_WEB = 'http://localhost:65535';
const BELZ_DEBOUNCE_MS = 250;

// ---- DOM ------------------------------------------------------------------
const recordBtn = document.getElementById('record');
const clearBtn = document.getElementById('clear');
const preserveBox = document.getElementById('preserve');
const filterInput = document.getElementById('filter');
const countEl = document.getElementById('count');
const offlineEl = document.getElementById('offline');
const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const detailEl = document.getElementById('detail');
const detailBody = document.getElementById('detail-body');
const detailClose = document.getElementById('detail-close');
const detailTabs = Array.from(document.querySelectorAll('.detail-tabs button'));

// ---- state ----------------------------------------------------------------
const entries = []; // newest-first; { id, uuid, kind, version, httpMethod, url,
                     //   status, type, size, time, har, rowEl, nameCell }
const uuidToName = new Map();
let nextId = 1;
let recording = true;
let preserveLog = false;
let filterText = '';
let selectedId = null;
let activeTab = 'headers';
let currentEnv = 'nsm-dev';

const pendingUuids = new Set();
let belzTimer = null;

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

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url || '';
  }
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

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) Object.assign(node, props);
  for (const k of kids) {
    if (k == null) continue;
    node.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return node;
}

// ---- name resolution ------------------------------------------------------
function learnName(uuid, name) {
  if (!uuid || !name) return;
  if (uuidToName.get(uuid) === name) return;
  uuidToName.set(uuid, name);
  for (const entry of entries) {
    if (entry.uuid === uuid) paintName(entry);
  }
  if (selectedId != null) {
    const sel = entries.find((e) => e.id === selectedId);
    if (sel && sel.uuid === uuid && activeTab === 'headers') renderDetail();
  }
}

function paintName(entry) {
  const name = uuidToName.get(entry.uuid);
  if (name) {
    entry.nameCell.textContent = name;
    entry.nameCell.className = 'name';
    entry.nameCell.title = name + '  ·  ' + entry.uuid;
  } else {
    entry.nameCell.textContent = entry.uuid.slice(0, 12) + '…';
    entry.nameCell.className = 'name pending';
    entry.nameCell.title = entry.uuid + '  (resolving…)';
  }
}

function setOffline(off) {
  offlineEl.classList.toggle('hidden', !off);
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
    if (!uuidToName.has(uuid)) uuids.push(uuid);
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
    const names = (data && data.names) || {};
    for (const uuid of Object.keys(names)) {
      if (names[uuid]) learnName(uuid, names[uuid]);
    }
  } catch {
    setOffline(true);
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
    type: typeOf(har),
    size: transferSize(har),
    time: typeof har.time === 'number' ? har.time : -1,
    har,
    rowEl: null,
    nameCell: null
  };
  entries.unshift(entry);
  renderRow(entry);

  // Resolve the method name.
  if (info.kind === 'fetch') {
    har.getContent((body) => {
      const name = extractMethodNameFromChainResponse(body || '');
      if (name) learnName(info.uuid, name);
    });
  } else if (!uuidToName.has(info.uuid)) {
    pendingUuids.add(info.uuid);
    scheduleBelzFetch();
  }

  // Cap the table.
  while (entries.length > MAX_ROWS) {
    const old = entries.pop();
    if (old && old.rowEl && old.rowEl.parentNode) old.rowEl.remove();
    if (old && old.id === selectedId) closeDetail();
  }
  countEl.textContent = String(entries.length);
}

function renderRow(entry) {
  emptyEl.classList.add('hidden');

  const nameCell = el('td', { className: 'name pending' });

  const statusCell = el('td', null, entry.status ? String(entry.status) : '—');
  statusCell.className =
    entry.status >= 200 && entry.status < 400 ? 'status-ok' : 'status-err';

  const httpCell = el('td', { className: 'dim' }, entry.httpMethod);

  const badge = el(
    'span',
    { className: 'badge ' + (entry.kind === 'execute' ? 'run' : 'get') },
    entry.kind === 'execute' ? 'RUN' : 'GET'
  );
  const kindCell = el('td', { className: 'dim' }, badge, ' ' + entry.version);

  const urlCell = el('td', { className: 'mono', title: entry.url }, shortUrl(entry.url));
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
    nameCell,
    statusCell,
    httpCell,
    kindCell,
    urlCell,
    typeCell,
    sizeCell,
    timeCell
  );
  row.addEventListener('click', () => selectEntry(entry));

  entry.rowEl = row;
  entry.nameCell = nameCell;
  paintName(entry);
  applyRowFilter(entry);

  rowsEl.insertBefore(row, rowsEl.firstChild);
}

// ---- filter ---------------------------------------------------------------
function rowMatches(entry) {
  if (!filterText) return true;
  const name = uuidToName.get(entry.uuid) || '';
  return (
    name.toLowerCase().includes(filterText) ||
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
  return Array.isArray(headers)
    ? headers.map((h) => [h.name, h.value])
    : [];
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
  const har = entry.har;

  if (activeTab === 'headers') {
    const name = uuidToName.get(entry.uuid);
    detailBody.append(
      el('h4', null, 'General'),
      kvGrid([
        ['Method name', name || '(resolving…)'],
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
  } else if (activeTab === 'payload') {
    const post = har.request && har.request.postData;
    const query = har.request && har.request.queryString;
    if (post && typeof post.text === 'string' && post.text) {
      detailBody.append(
        el('h4', null, 'Request payload'),
        el('pre', null, prettyMaybeJson(post.text))
      );
    }
    if (Array.isArray(query) && query.length) {
      detailBody.append(
        el('h4', null, 'Query string'),
        kvGrid(query.map((q) => [q.name, q.value]))
      );
    }
    if (!detailBody.childNodes.length) {
      detailBody.append(el('pre', null, 'No request payload.'));
    }
  } else if (activeTab === 'response') {
    detailBody.append(el('pre', null, 'Loading response…'));
    const token = entry.id;
    har.getContent((body) => {
      if (selectedId !== token || activeTab !== 'response') return;
      detailBody.replaceChildren(
        el('h4', null, 'Response body'),
        el('pre', null, body ? prettyMaybeJson(body) : '(empty)')
      );
    });
  } else if (activeTab === 'timing') {
    const rows = [['Total', Math.round(har.time || 0) + ' ms']];
    const t = har.timings || {};
    for (const key of ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive']) {
      if (typeof t[key] === 'number' && t[key] >= 0) {
        rows.push([key, Math.round(t[key]) + ' ms']);
      }
    }
    detailBody.append(el('h4', null, 'Timing'), kvGrid(rows));
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
