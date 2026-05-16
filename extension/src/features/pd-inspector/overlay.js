// The PD Inspector overlay — floating icon, info panel, config tree, and the
// inspect-mode wiring. Everything lives inside a shadow root so the published
// page cannot style it and it cannot style the page.

import { OVERLAY_CSS } from './styles.js';
import { KIND_BADGE, summarize } from './tree.js';
import { indexByFieldName, countByKind, nearestExpElement } from './correlate.js';
import { createInspector, esc } from './inspect.js';

/**
 * Mount the overlay on the current published page.
 * @param {{ ctx: object, config: object, tree: object|null }} data
 */
export function mountOverlay(data) {
  const { ctx, config, tree } = data;

  const host = document.createElement('div');
  host.id = 'pdi-host';
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  root.appendChild(style);

  const highlightEl = el('div', 'pdi-highlight');
  const tipEl = el('div', 'pdi-tip');
  root.append(highlightEl, tipEl);

  // ---- floating icon -------------------------------------------------------
  const icon = el('div', 'pdi-icon');
  icon.textContent = '◎'; // bullseye
  icon.title = 'PD Inspector';
  root.appendChild(icon);

  // ---- panel ---------------------------------------------------------------
  const panel = el('div', 'pdi-panel');
  root.appendChild(panel);

  const sums = summarize(tree);
  panel.appendChild(buildHead(() => togglePanel(false)));
  panel.appendChild(buildInfo(ctx, config, sums));

  const inspectBtn = el('button', 'pdi-btn');
  inspectBtn.textContent = 'Inspect';
  panel.appendChild(buildActions(ctx, config, inspectBtn));

  const treeWrap = el('div', 'pdi-treewrap');
  panel.appendChild(treeWrap);

  // ---- tree ----------------------------------------------------------------
  /** @type {Map<string,{row:HTMLElement,detail:HTMLElement|null}>} */
  const nodeEls = new Map();
  let selectedId = null;

  if (tree) {
    renderTree(tree, treeWrap, nodeEls, {
      onSelect: selectNode,
      onLocate: locateNode
    });
  } else {
    const empty = el('div', 'pdi-tree-empty');
    empty.textContent = 'No layout in compiled config.';
    treeWrap.appendChild(empty);
  }

  function selectNode(id) {
    if (selectedId && nodeEls.has(selectedId)) {
      nodeEls.get(selectedId).row.classList.remove('pdi-sel');
    }
    selectedId = id;
    const entry = nodeEls.get(id);
    if (entry) {
      entry.row.classList.add('pdi-sel');
      entry.row.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---- inspect mode --------------------------------------------------------
  const fieldIndex = indexByFieldName(tree);
  const kindCounts = countByKind(tree);
  const inspector = createInspector({
    highlightEl,
    tipEl,
    shadowHost: host,
    getContext: () => ({ fieldIndex, kindCounts }),
    onPick: (info) => {
      if (info.node) {
        revealNode(info.node.id);
        selectNode(info.node.id);
      }
    }
  });

  inspectBtn.addEventListener('click', () => {
    if (inspector.isActive()) {
      inspector.stop();
      inspectBtn.classList.remove('pdi-toggle-on');
      icon.classList.remove('pdi-active');
    } else {
      inspector.start();
      inspectBtn.classList.add('pdi-toggle-on');
      icon.classList.add('pdi-active');
    }
  });

  /** Expand every ancestor of a node so its row is visible, then scroll to it. */
  function revealNode(id) {
    const entry = nodeEls.get(id);
    if (!entry) return;
    let p = entry.row.parentElement;
    while (p && p !== treeWrap) {
      if (p.classList.contains('pdi-children')) p.style.display = 'block';
      p = p.parentElement;
    }
  }

  /** Flash the live DOM element for a config node (form fields only). */
  function locateNode(node) {
    if (!node.fieldName) return false;
    let live = null;
    try {
      live = document.querySelector(`[name="${cssEscape(node.fieldName)}"]`);
    } catch {
      live = null;
    }
    if (!live) return false;
    const expEl = nearestExpElement(live) || live;
    expEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashHighlight(expEl);
    return true;
  }

  function flashHighlight(expEl) {
    const r = expEl.getBoundingClientRect();
    highlightEl.style.display = 'block';
    highlightEl.style.left = `${r.left}px`;
    highlightEl.style.top = `${r.top}px`;
    highlightEl.style.width = `${r.width}px`;
    highlightEl.style.height = `${r.height}px`;
    if (!inspector.isActive()) {
      clearTimeout(flashHighlight._t);
      flashHighlight._t = setTimeout(() => {
        highlightEl.style.display = 'none';
      }, 1400);
    }
  }

  // ---- open/close ----------------------------------------------------------
  function togglePanel(open) {
    panel.classList.toggle('pdi-open', open);
    icon.style.display = open ? 'none' : 'flex';
    if (!open && inspector.isActive()) {
      inspector.stop();
      inspectBtn.classList.remove('pdi-toggle-on');
      icon.classList.remove('pdi-active');
    }
  }
  icon.addEventListener('click', () => togglePanel(true));

  document.documentElement.appendChild(host);
}

// ---- panel sections --------------------------------------------------------

function buildHead(onClose) {
  const head = el('div', 'pdi-head');
  const title = el('span', 'pdi-title');
  title.textContent = 'PD Inspector';
  const x = el('span', 'pdi-x');
  x.textContent = '✕';
  x.title = 'Close';
  x.addEventListener('click', onClose);
  head.append(title, x);
  return head;
}

function buildInfo(ctx, config, sums) {
  const info = el('div', 'pdi-info');
  info.appendChild(infoRow('Path', config.path || ctx.path));
  info.appendChild(infoRow('Env', ctx.env));
  if (config.referencePageId) {
    info.appendChild(infoRow('PD page id', config.referencePageId, true));
  }
  if (config.pageVersionId) {
    info.appendChild(infoRow('Version', String(config.pageVersionId)));
  }
  info.appendChild(
    infoRow(
      'Config',
      `${sums.total} nodes · ${sums.bound} conditional · ${sums.hidden} hidden`
    )
  );
  return info;
}

function infoRow(key, value, copyable) {
  const row = el('div', 'pdi-row');
  const k = el('span', 'pdi-k');
  k.textContent = key;
  const v = el('span', 'pdi-v');
  v.textContent = value;
  if (copyable) {
    v.classList.add('pdi-copy');
    v.title = 'Click to copy';
    v.addEventListener('click', () => copyText(value, v));
  }
  row.append(k, v);
  return row;
}

function buildActions(ctx, config, inspectBtn) {
  const actions = el('div', 'pdi-actions');

  const openBtn = el('button', 'pdi-btn');
  openBtn.textContent = 'Open PD page';
  if (config.referencePageId) {
    const url = `https://${ctx.host}/ui-designer/page/${config.referencePageId}`;
    openBtn.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  } else {
    openBtn.disabled = true;
    openBtn.title = 'No reference page id in config';
  }

  actions.append(openBtn, inspectBtn);
  return actions;
}

// ---- tree ------------------------------------------------------------------

function renderTree(node, container, nodeEls, cb) {
  const row = el('div', 'pdi-node');
  row.style.paddingLeft = `${8 + node.depth * 12}px`;

  const caret = el('span', 'pdi-caret');
  const hasKids = node.children.length > 0;
  caret.textContent = hasKids ? '▾' : '';
  if (!hasKids) caret.classList.add('pdi-leaf');

  const badge = el('span', `pdi-badge pdi-k-${node.kind}`);
  badge.textContent = KIND_BADGE[node.kind] || node.kind;

  const label = el('span', 'pdi-label');
  label.textContent = node.label;
  label.title = `${node.name} · ${node.id}`;

  row.append(caret, badge, label);

  if (node.visibility.kind === 'bound') {
    const vis = el('span', 'pdi-vis pdi-vis-bound');
    vis.textContent = '◑ cond';
    vis.title = node.visibility.expr;
    row.appendChild(vis);
  } else if (node.visibility.kind === 'static-hidden') {
    const vis = el('span', 'pdi-vis pdi-vis-hidden');
    vis.textContent = '⊘ hidden';
    row.appendChild(vis);
  }

  container.appendChild(row);
  nodeEls.set(node.id, { row, detail: null });

  let kidsWrap = null;
  if (hasKids) {
    kidsWrap = el('div', 'pdi-children');
    if (node.depth >= 1) kidsWrap.style.display = 'none';
    if (node.depth >= 1) caret.textContent = '▸';
    container.appendChild(kidsWrap);
    node.children.forEach((c) => renderTree(c, kidsWrap, nodeEls, cb));
  }

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!kidsWrap) return;
    const collapsed = kidsWrap.style.display === 'none';
    kidsWrap.style.display = collapsed ? 'block' : 'none';
    caret.textContent = collapsed ? '▾' : '▸';
  });

  row.addEventListener('click', () => {
    cb.onSelect(node.id);
    toggleDetail(node, row, nodeEls, cb);
  });
}

function toggleDetail(node, row, nodeEls, cb) {
  const entry = nodeEls.get(node.id);
  if (entry.detail) {
    entry.detail.remove();
    entry.detail = null;
    return;
  }
  const detail = el('div', 'pdi-detail');
  detail.appendChild(detailRow('id', node.id, true));
  detail.appendChild(detailRow('tag', node.name));
  if (node.fieldName) detail.appendChild(detailRow('field', node.fieldName));

  if (node.visibility.kind === 'bound') {
    const r = el('div', 'pdi-d-row');
    const k = el('span', 'pdi-d-k');
    k.textContent = 'visible if';
    const expr = el('code', 'pdi-expr');
    expr.textContent = node.visibility.expr;
    r.append(k, expr);
    detail.appendChild(r);
  } else if (node.visibility.kind === 'static-hidden') {
    detail.appendChild(detailRow('visible', 'false (statically hidden)'));
  }

  if (node.fieldName) {
    const r = el('div', 'pdi-d-row');
    const locate = el('span', 'pdi-d-copy');
    locate.textContent = '→ locate on page';
    locate.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!cb.onLocate(node)) {
        locate.textContent = 'not visible on page';
      }
    });
    r.appendChild(locate);
    detail.appendChild(r);
  }

  row.after(detail);
  entry.detail = detail;
}

function detailRow(key, value, copyable) {
  const row = el('div', 'pdi-d-row');
  const k = el('span', 'pdi-d-k');
  k.textContent = key;
  const v = el('span', 'pdi-d-v');
  v.textContent = value;
  if (copyable) {
    v.classList.add('pdi-d-copy');
    v.title = 'Click to copy';
    v.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(value, v);
    });
  }
  row.append(k, v);
  return row;
}

// ---- helpers ---------------------------------------------------------------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function copyText(text, feedbackEl) {
  const done = () => {
    const prev = feedbackEl.textContent;
    feedbackEl.textContent = 'copied!';
    setTimeout(() => {
      feedbackEl.textContent = prev;
    }, 900);
  };
  try {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } catch {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    /* give up silently */
  }
  ta.remove();
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, '\\$&');
}

export { esc };
