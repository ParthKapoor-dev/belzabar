// Chain Inspector — in-page HUD (isolated-world content-script feature).
//
// Listens for the records posted by the MAIN-world interceptor and renders a
// small floating panel listing every AD chain request with its method name.
// Method names come from two sources:
//   1. definition-fetch responses (the interceptor reads the name out of them)
//   2. the AD page itself — the open method's name + uuid, so that `execute`
//      calls (whose responses carry no name) are still labelled.

import { EXTENSION_OWNED_ATTR } from '../../config/constants.js';
import { extractMethodName } from '../../utils/dom.js';

const MESSAGE_SOURCE = 'belz-chain-inspector';
const MAX_ROWS = 120;
const COLLAPSE_KEY = 'sdChainInspectorCollapsed';
const UUID_RE = /[0-9a-f]{32}/i;

function currentPageUuid() {
  const m = window.location.pathname.match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

export function startChainInspectorFeature() {
  // Chain requests only happen inside Automation Designer.
  if (!window.location.pathname.includes('/automation-designer/')) {
    return () => {};
  }

  const uuidToName = new Map();
  const rows = []; // { uuid, kind, status, nameEl, row }
  let rowCount = 0;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    collapsed = false;
  }

  // ---- DOM ------------------------------------------------------------------
  const host = document.createElement('div');
  host.setAttribute(EXTENSION_OWNED_ATTR, 'true');
  Object.assign(host.style, {
    position: 'fixed',
    bottom: '12px',
    right: '12px',
    width: '360px',
    maxHeight: '52vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #3a3a3a',
    borderRadius: '6px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    font: '12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    zIndex: '2147483000',
    overflow: 'hidden'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px 6px 10px',
    background: '#252526',
    borderBottom: '1px solid #3a3a3a',
    cursor: 'default',
    userSelect: 'none'
  });

  const title = document.createElement('span');
  title.textContent = 'AD Chains';
  Object.assign(title.style, { fontWeight: '600', color: '#4ec9b0' });

  const count = document.createElement('span');
  count.textContent = '0';
  Object.assign(count.style, {
    color: '#888',
    fontVariantNumeric: 'tabular-nums',
    flex: '1'
  });

  function mkBtn(label) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      font: 'inherit',
      background: '#333',
      color: '#d4d4d4',
      border: '1px solid #444',
      borderRadius: '3px',
      padding: '1px 7px',
      cursor: 'pointer'
    });
    return b;
  }

  const clearBtn = mkBtn('clear');
  const collapseBtn = mkBtn(collapsed ? '▴' : '▾');

  header.append(title, count, clearBtn, collapseBtn);

  const list = document.createElement('div');
  Object.assign(list.style, { overflowY: 'auto', flex: '1' });

  const empty = document.createElement('div');
  empty.textContent = 'Waiting for chain requests — open or run an AD method.';
  Object.assign(empty.style, {
    padding: '14px 12px',
    color: '#777',
    textAlign: 'center'
  });
  list.appendChild(empty);

  host.append(header, list);

  function applyCollapsed() {
    list.style.display = collapsed ? 'none' : 'block';
    collapseBtn.textContent = collapsed ? '▴' : '▾';
  }
  applyCollapsed();

  // ---- name resolution ------------------------------------------------------
  function displayName(uuid) {
    return uuidToName.get(uuid) || null;
  }

  function refreshRowsFor(uuid) {
    const name = displayName(uuid);
    for (const r of rows) {
      if (r.uuid !== uuid) continue;
      if (name) {
        r.nameEl.textContent = name;
        r.nameEl.style.color = '#9cdcfe';
        r.nameEl.style.fontStyle = 'normal';
      }
    }
  }

  function learnName(uuid, name) {
    if (!uuid || !name) return;
    if (uuidToName.get(uuid) === name) return;
    uuidToName.set(uuid, name);
    refreshRowsFor(uuid);
  }

  // ---- rows -----------------------------------------------------------------
  function addRow(rec) {
    if (empty.parentNode) empty.remove();

    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      padding: '4px 10px',
      borderBottom: '1px solid #2a2a2a',
      cursor: 'pointer'
    });
    row.title = rec.uuid + '  ·  click to copy uuid';

    const badge = document.createElement('span');
    badge.textContent = rec.kind === 'execute' ? 'RUN' : 'GET';
    Object.assign(badge.style, {
      fontSize: '9px',
      fontWeight: '700',
      letterSpacing: '0.05em',
      padding: '1px 4px',
      borderRadius: '3px',
      color: '#1e1e1e',
      background: rec.kind === 'execute' ? '#dcb67a' : '#6a9bd1',
      flexShrink: '0'
    });

    const nameEl = document.createElement('span');
    const known = displayName(rec.uuid);
    nameEl.textContent = known || rec.uuid.slice(0, 8) + '…';
    Object.assign(nameEl.style, {
      flex: '1',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: known ? '#9cdcfe' : '#888',
      fontStyle: known ? 'normal' : 'italic'
    });

    const status = document.createElement('span');
    status.textContent = rec.status || '—';
    Object.assign(status.style, {
      fontSize: '11px',
      fontVariantNumeric: 'tabular-nums',
      flexShrink: '0',
      color: rec.status >= 200 && rec.status < 300 ? '#6a9955' : '#f48771'
    });

    const time = document.createElement('span');
    time.textContent = new Date(rec.at || Date.now()).toLocaleTimeString();
    Object.assign(time.style, { fontSize: '10px', color: '#666', flexShrink: '0' });

    row.append(badge, nameEl, status, time);
    row.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(rec.uuid);
      } catch {
        /* ignore */
      }
      const prev = nameEl.textContent;
      nameEl.textContent = 'uuid copied';
      setTimeout(() => {
        nameEl.textContent = displayName(rec.uuid) || prev;
      }, 800);
    });

    list.insertBefore(row, list.firstChild);
    rows.unshift({ uuid: rec.uuid, kind: rec.kind, status: rec.status, nameEl, row });

    rowCount += 1;
    count.textContent = String(rowCount);

    while (rows.length > MAX_ROWS) {
      const old = rows.pop();
      if (old && old.row.parentNode) old.row.remove();
    }
  }

  // ---- events ---------------------------------------------------------------
  function onMessage(event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== MESSAGE_SOURCE || typeof d.uuid !== 'string') return;
    if (d.name) learnName(d.uuid, d.name);
    addRow(d);
  }

  // Keep the open method's name → uuid mapping current so `execute` rows resolve.
  function syncPageMethod() {
    const uuid = currentPageUuid();
    if (!uuid) return;
    const name = extractMethodName();
    if (name) learnName(uuid, name);
  }

  // The AD SPA mutates constantly — throttle the DOM scan to once per 500ms.
  let syncTimer = null;
  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncPageMethod();
    }, 500);
  }

  const pageObserver = new MutationObserver(scheduleSync);

  clearBtn.addEventListener('click', () => {
    rows.length = 0;
    rowCount = 0;
    count.textContent = '0';
    list.replaceChildren(empty);
  });

  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
    applyCollapsed();
  });

  window.addEventListener('message', onMessage);
  pageObserver.observe(document.documentElement, { childList: true, subtree: true });
  document.body.appendChild(host);
  syncPageMethod();

  // ---- cleanup --------------------------------------------------------------
  return () => {
    window.removeEventListener('message', onMessage);
    pageObserver.disconnect();
    if (syncTimer) clearTimeout(syncTimer);
    if (host.parentNode) host.remove();
  };
}
