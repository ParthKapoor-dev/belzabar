// JSON tree viewer for the "AD Network" DevTools panel.
//
// A collapsible, colour-coded JSON inspector — much like the browser's own
// Network-tab response viewer: array-length badges, collapsed previews, a
// property filter, expand/collapse-all, and a Raw toggle back to plain text.
//
// Vanilla DOM only (no framework), to match panel.js. All nodes are built with
// textContent, so payload contents can never inject markup.

const INDENT_PX = 13;

// ---- value formatting -----------------------------------------------------
function primitiveClass(value) {
  if (value === null) return 'jt-null';
  switch (typeof value) {
    case 'string':
      return 'jt-str';
    case 'number':
      return 'jt-num';
    case 'boolean':
      return 'jt-bool';
    default:
      return 'jt-null';
  }
}

function formatPrimitive(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

// Short one-token preview of a value, used inside a parent's collapsed preview.
function previewToken(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? '[…]' : '[]';
  if (typeof value === 'object') return Object.keys(value).length ? '{…}' : '{}';
  if (typeof value === 'string') {
    return value.length > 24
      ? JSON.stringify(value.slice(0, 24) + '…')
      : JSON.stringify(value);
  }
  return String(value);
}

// Inline preview shown on a collapsed object/array row.
function previewOf(value) {
  if (Array.isArray(value)) {
    if (!value.length) return '[ ]';
    const shown = value.slice(0, 5).map(previewToken);
    return '[ ' + shown.join(', ') + (value.length > 5 ? ', …' : '') + ' ]';
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{ }';
  const shown = keys
    .slice(0, 3)
    .map((k) => k + ': ' + previewToken(value[k]));
  return '{ ' + shown.join(', ') + (keys.length > 3 ? ', …' : '') + ' }';
}

// ---- node model -----------------------------------------------------------
// Each node pairs the raw value with its DOM and exposes expand/collapse so the
// toolbar (filter, expand-all) can drive every node uniformly.
function makeNode(key, value, depth) {
  const node = {
    key,
    value,
    container: isContainer(value),
    childNodes: [],
    expanded: false,
    el: null,
    row: null,
    childrenEl: null
  };

  const el = document.createElement('div');
  el.className = 'jt-node';
  const row = document.createElement('div');
  row.className = 'jt-row';
  row.style.paddingLeft = depth * INDENT_PX + 4 + 'px';

  const caret = document.createElement('span');
  caret.className = 'jt-caret';

  if (key !== null) {
    const keyEl = document.createElement('span');
    keyEl.className = 'jt-key';
    keyEl.textContent = key;
    row.append(caret, keyEl, document.createTextNode(': '));
  } else {
    row.append(caret);
  }

  node.el = el;
  node.row = row;
  el.append(row);

  if (!node.container) {
    const valEl = document.createElement('span');
    valEl.className = 'jt-val ' + primitiveClass(value);
    valEl.textContent = formatPrimitive(value);
    row.append(valEl);
    return node;
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  const empty = entries.length === 0;

  if (isArray) {
    const count = document.createElement('span');
    count.className = 'jt-count';
    count.textContent = '(' + value.length + ')';
    row.append(count);
  }

  // Collapsed preview — replaced by the expanded children on toggle.
  const preview = document.createElement('span');
  preview.className = 'jt-preview';
  preview.textContent = previewOf(value);
  row.append(preview);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'jt-children';
  childrenEl.style.display = 'none';
  node.childrenEl = childrenEl;
  el.append(childrenEl);

  for (const [k, v] of entries) {
    const child = makeNode(k, v, depth + 1);
    node.childNodes.push(child);
    childrenEl.append(child.el);
  }

  if (empty) {
    caret.classList.add('jt-caret-empty');
    return node;
  }

  caret.classList.add('jt-caret-toggle');
  const toggle = () => setExpanded(node, !node.expanded);
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  row.addEventListener('click', toggle);

  return node;
}

function setExpanded(node, expanded) {
  if (!node.container || !node.childrenEl || node.childNodes.length === 0) return;
  node.expanded = expanded;
  node.childrenEl.style.display = expanded ? '' : 'none';
  node.row.classList.toggle('jt-open', expanded);
}

function eachContainer(nodes, fn) {
  for (const n of nodes) {
    if (n.container && n.childNodes.length) {
      fn(n);
      eachContainer(n.childNodes, fn);
    }
  }
}

// ---- filtering ------------------------------------------------------------
// A node stays visible when it matches, has a matching descendant, or sits
// under a matching ancestor. Containers with a matching descendant auto-expand.
function applyFilter(nodes, query) {
  const q = query.trim().toLowerCase();

  const visit = (node, ancestorMatched) => {
    const keyMatch =
      node.key !== null && String(node.key).toLowerCase().includes(q);
    const valMatch =
      !node.container &&
      formatPrimitive(node.value).toLowerCase().includes(q);
    const selfMatch = q !== '' && (keyMatch || valMatch);

    let descMatch = false;
    for (const child of node.childNodes) {
      if (visit(child, ancestorMatched || selfMatch)) descMatch = true;
    }

    const visible = q === '' || selfMatch || descMatch || ancestorMatched;
    node.el.classList.toggle('jt-hidden', !visible);
    node.row.classList.toggle('jt-match', selfMatch);
    if (q !== '' && descMatch) setExpanded(node, true);

    return selfMatch || descMatch;
  };

  for (const node of nodes) visit(node, false);
}

// ---- public API -----------------------------------------------------------
// Returns { element } — a self-contained view. Falls back to a <pre> of the
// raw text when the body is not JSON.
export function createJsonView(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const pre = document.createElement('pre');
    pre.textContent = text || '(empty)';
    return { element: pre };
  }

  const pretty = JSON.stringify(parsed, null, 2);

  const view = document.createElement('div');
  view.className = 'jsonview';

  // toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'jt-toolbar';

  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'jt-filter';
  filter.placeholder = 'Filter properties';

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'jt-btn';
  expandBtn.textContent = 'Expand all';

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'jt-btn';
  collapseBtn.textContent = 'Collapse all';

  const spacer = document.createElement('span');
  spacer.className = 'jt-spacer';

  const rawLabel = document.createElement('label');
  rawLabel.className = 'jt-raw-toggle';
  const rawCheck = document.createElement('input');
  rawCheck.type = 'checkbox';
  rawLabel.append(rawCheck, document.createTextNode(' Raw'));

  toolbar.append(filter, expandBtn, collapseBtn, spacer, rawLabel);

  // tree body
  const body = document.createElement('div');
  body.className = 'jt-body';

  const rootNodes = [];
  if (isContainer(parsed)) {
    const entries = Array.isArray(parsed)
      ? parsed.map((v, i) => [String(i), v])
      : Object.entries(parsed);
    for (const [k, v] of entries) {
      const node = makeNode(k, v, 0);
      rootNodes.push(node);
      body.append(node.el);
    }
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'jt-row';
      empty.textContent = Array.isArray(parsed) ? '[ ]' : '{ }';
      body.append(empty);
    }
  } else {
    const node = makeNode(null, parsed, 0);
    rootNodes.push(node);
    body.append(node.el);
  }

  // raw view
  const raw = document.createElement('pre');
  raw.className = 'jt-raw hidden';
  raw.textContent = pretty;

  // wiring
  filter.addEventListener('input', () => applyFilter(rootNodes, filter.value));
  expandBtn.addEventListener('click', () =>
    eachContainer(rootNodes, (n) => setExpanded(n, true))
  );
  collapseBtn.addEventListener('click', () =>
    eachContainer(rootNodes, (n) => setExpanded(n, false))
  );
  rawCheck.addEventListener('change', () => {
    const showRaw = rawCheck.checked;
    raw.classList.toggle('hidden', !showRaw);
    body.classList.toggle('hidden', showRaw);
    filter.classList.toggle('hidden', showRaw);
    expandBtn.classList.toggle('hidden', showRaw);
    collapseBtn.classList.toggle('hidden', showRaw);
  });

  view.append(toolbar, body, raw);
  return { element: view };
}
