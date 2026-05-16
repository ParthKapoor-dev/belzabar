// "PD Inspector" DevTools panel.
//
// The UI half of the PD Inspector. It talks to the page-side engine (the
// pd-inspector.js content script) over chrome messaging: it pulls the
// component-nesting tree to display, drives inspect mode, and highlights a
// component on the page when one is selected here.

const tabId = chrome.devtools.inspectedWindow.tabId;
const bodyEl = document.getElementById('body');
const inspectBtn = document.getElementById('inspect');
const refreshBtn = document.getElementById('refresh');

const KIND_BADGE = {
  FORM_FIELD: 'FIELD',
  DATA_TABLE: 'TABLE',
  BUTTON: 'BTN',
  SYMBOL: 'SYM',
  LAYOUT: 'LAYOUT',
  GENERIC: '-'
};

let inspecting = false;
let pageInfo = null;
/** name -> first .comp row element, for pick-driven selection. */
const compRows = new Map();

// ---- engine messaging ------------------------------------------------------

/** Send a command to the page-side engine; resolves null if it is not there. */
function callEngine(cmd, extra) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { ns: 'pd', cmd, ...extra }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp);
    });
  });
}

// ---- DOM helpers -----------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function openInPd(kind, idOrName) {
  if (!pageInfo || !idOrName) return;
  const base = `https://${pageInfo.host}/ui-designer`;
  const url =
    kind === 'page'
      ? `${base}/page/${idOrName}`
      : `${base}/symbol/${encodeURIComponent(idOrName)}`;
  chrome.tabs.create({ url });
}

// ---- top-level render ------------------------------------------------------

function showNotice(text) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(el('div', 'notice', text));
  inspectBtn.disabled = true;
}

async function loadState(attempt) {
  const state = await callEngine('getState');
  if (!state) {
    showNotice(
      'Open a published page (…/pages/…) in this tab. If you just installed ' +
        'or reloaded the extension, reload the page once so the inspector loads.'
    );
    return;
  }
  if (state.status === 'loading') {
    if ((attempt || 0) < 12) {
      setTimeout(() => loadState((attempt || 0) + 1), 400);
    } else {
      showNotice('Still loading the page config…  try Refresh.');
    }
    return;
  }
  if (state.status === 'error') {
    showNotice(`Could not load the page config: ${state.error}`);
    return;
  }
  pageInfo = state.pageInfo;
  inspectBtn.disabled = false;
  render(state);
}

function render(state) {
  bodyEl.innerHTML = '';
  compRows.clear();
  bodyEl.appendChild(buildInfo(state.pageInfo));

  const split = el('div', 'split');
  const treePane = el('div', 'pane-tree');
  treePane.id = 'tree';
  const detailPane = el('div', 'pane-detail');
  detailPane.id = 'detail';
  detailPane.appendChild(el('div', 'detail-empty', 'Select a component to see its layout.'));
  split.append(treePane, detailPane);
  bodyEl.appendChild(split);

  renderComponent(state.componentTree, treePane, 0, detailPane);
}

function buildInfo(info) {
  const box = el('div', 'info');
  const row = (k, vNode) => {
    const r = el('div', 'row');
    r.append(el('span', 'k', k), vNode);
    return r;
  };
  box.appendChild(row('Path', el('span', 'v', info.path)));
  box.appendChild(row('Env', el('span', 'v', info.env)));

  if (info.referencePageId) {
    const v = el('span', 'v link', info.referencePageId);
    v.title = 'Open this page in Page Designer';
    v.addEventListener('click', () => openInPd('page', info.referencePageId));
    box.appendChild(row('PD page', v));
  }
  box.appendChild(row('Components', el('span', 'v', String(info.componentCount))));

  const c = info.correlation;
  const CONF = {
    exact: 'exact — 1:1 with the page',
    approx: 'approx — conditional regions accounted for',
    low: 'low — page has hidden regions the map cannot place'
  };
  const corr = el(
    'span',
    `v ${c.confidence === 'exact' ? 'ok' : 'warn'}`,
    `${CONF[c.confidence] || c.confidence} (${c.domAnchors}/${c.expectedAnchors} anchors)`
  );
  box.appendChild(row('Inspect map', corr));

  const picked = el('div', 'row');
  picked.id = 'picked-row';
  picked.style.display = 'none';
  picked.append(el('span', 'k', 'Picked'), el('span', 'v warn', ''));
  box.appendChild(picked);
  return box;
}

// ---- component tree --------------------------------------------------------

function renderComponent(node, container, depth, detailPane) {
  const rowWrap = el('div');
  const row = el('div', 'comp');
  row.style.paddingLeft = `${8 + depth * 14}px`;

  row.appendChild(el('span', `badge ${node.isPage ? 'page' : 'comp'}`, node.isPage ? 'PAGE' : 'COMP'));
  row.appendChild(el('span', 'cname', node.name));

  if (node.error) {
    const e = el('span', 'csum warn', '!');
    e.title = node.error;
    row.appendChild(e);
  } else {
    const s = node.nodeSummary;
    row.appendChild(el('span', 'csum', `${s.total}n·${s.bound}c`));
  }

  const open = el('span', 'openpd', '↗ PD');
  open.title = 'Open in Page Designer';
  open.addEventListener('click', (e) => {
    e.stopPropagation();
    if (node.isPage) openInPd('page', node.referencePageId);
    else openInPd('symbol', node.name);
  });
  row.appendChild(open);

  row.addEventListener('click', () => selectComponent(node, row, detailPane));
  rowWrap.appendChild(row);
  if (!compRows.has(node.name)) compRows.set(node.name, row);

  node.children.forEach((child) =>
    renderComponent(child, rowWrap, depth + 1, detailPane)
  );
  container.appendChild(rowWrap);
}

function selectComponent(node, row, detailPane) {
  document.querySelectorAll('.comp.sel').forEach((r) => r.classList.remove('sel'));
  row.classList.add('sel');
  renderDetail(node, detailPane);
  if (!node.isPage) callEngine('highlightComponent', { name: node.name });
}

// ---- detail: a component's config node tree --------------------------------

function renderDetail(node, detailPane) {
  detailPane.innerHTML = '';
  const head = el('div', 'detail-head');
  head.appendChild(el('span', `badge ${node.isPage ? 'page' : 'comp'}`, node.isPage ? 'PAGE' : 'COMP'));
  head.appendChild(el('span', 'nm', node.name));
  const open = el('span', 'openpd', '↗ open in PD');
  open.addEventListener('click', () => {
    if (node.isPage) openInPd('page', node.referencePageId);
    else openInPd('symbol', node.name);
  });
  head.appendChild(open);
  detailPane.appendChild(head);

  if (node.error) {
    detailPane.appendChild(el('div', 'detail-empty', `Config unavailable: ${node.error}`));
    return;
  }
  if (!node.nodeTree) {
    detailPane.appendChild(el('div', 'detail-empty', 'No layout in this component.'));
    return;
  }
  const s = node.nodeSummary;
  detailPane.appendChild(
    el('div', 'detail-empty', `${s.total} nodes · ${s.bound} conditional · ${s.hidden} hidden`)
  );
  renderNode(node.nodeTree, detailPane);
}

function renderNode(n, container) {
  const row = el('div', 'node');
  row.style.paddingLeft = `${10 + n.depth * 12}px`;

  const caret = el('span', 'caret');
  const hasKids = n.children && n.children.length > 0;
  caret.textContent = hasKids ? '▾' : '';
  if (!hasKids) caret.classList.add('leaf');
  row.appendChild(caret);

  row.appendChild(el('span', `nbadge k-${n.kind}`, KIND_BADGE[n.kind] || n.kind));
  const label = el('span', 'nlabel', n.label);
  label.title = `${n.name} · ${n.id}`;
  row.appendChild(label);

  if (n.visibility.kind === 'bound') {
    const v = el('span', 'vis bound', '◑ cond');
    v.title = n.visibility.expr || '';
    row.appendChild(v);
  } else if (n.visibility.kind === 'static-hidden') {
    row.appendChild(el('span', 'vis hidden', '⊘ hidden'));
  }
  container.appendChild(row);

  if (n.visibility.kind === 'bound' && n.visibility.expr) {
    const expr = el('div', 'expr', `visible if  ${n.visibility.expr}`);
    expr.style.display = 'none';
    container.appendChild(expr);
    row.addEventListener('click', () => {
      expr.style.display = expr.style.display === 'none' ? 'block' : 'none';
    });
  }

  if (hasKids) {
    const kids = el('div');
    n.children.forEach((c) => renderNode(c, kids));
    container.appendChild(kids);
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      const hidden = kids.style.display === 'none';
      kids.style.display = hidden ? 'block' : 'none';
      caret.textContent = hidden ? '▾' : '▸';
    });
  }
}

// ---- inspect-mode pick events ---------------------------------------------

function onPick(chain) {
  const pickedRow = document.getElementById('picked-row');
  if (pickedRow) {
    pickedRow.style.display = 'flex';
    pickedRow.querySelector('.v').textContent = chain.join('  ›  ');
  }
  const inner = chain[chain.length - 1];
  document.querySelectorAll('.comp.picked').forEach((r) => r.classList.remove('picked'));
  const row = compRows.get(inner);
  if (row) {
    row.classList.add('picked');
    row.scrollIntoView({ block: 'nearest' });
    row.click();
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.ns !== 'pd' || msg.type !== 'pick') return;
  if (Array.isArray(msg.chain)) onPick(msg.chain);
});

// ---- controls --------------------------------------------------------------

inspectBtn.addEventListener('click', async () => {
  inspecting = !inspecting;
  inspectBtn.classList.toggle('on', inspecting);
  inspectBtn.textContent = inspecting ? 'Inspecting…' : 'Inspect';
  await callEngine('setInspect', { on: inspecting });
});

refreshBtn.addEventListener('click', () => {
  inspecting = false;
  inspectBtn.classList.remove('on');
  inspectBtn.textContent = 'Inspect';
  loadState(0);
});

chrome.devtools.network.onNavigated.addListener(() => {
  inspecting = false;
  inspectBtn.classList.remove('on');
  inspectBtn.textContent = 'Inspect';
  loadState(0);
});

loadState(0);
