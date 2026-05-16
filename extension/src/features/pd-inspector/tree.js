// Config-tree model.
//
// Turns a raw compiled-config `layout` node (the wire `RawLayoutNode` shape:
// id, name, props, children, field, isSymbol, _elementId) into a normalized
// tree the overlay can render — with a node kind, a human label, and the
// visibility verdict that drives the "conditionally hidden" workflow.

export const KIND = {
  FORM_FIELD: 'FORM_FIELD',
  DATA_TABLE: 'DATA_TABLE',
  BUTTON: 'BUTTON',
  SYMBOL: 'SYMBOL',
  LAYOUT: 'LAYOUT',
  GENERIC: 'GENERIC'
};

/** Short badge text per kind, shown in the tree. */
export const KIND_BADGE = {
  FORM_FIELD: 'FIELD',
  DATA_TABLE: 'TABLE',
  BUTTON: 'BTN',
  SYMBOL: 'SYM',
  LAYOUT: 'LAYOUT',
  GENERIC: '-'
};

/** @param {object} raw @returns {string} */
function detectKind(raw) {
  const name = String(raw.name || '').toLowerCase();
  if (raw.field || name === 'exp-form-field' || name === 'exp-field') {
    return KIND.FORM_FIELD;
  }
  if (name.includes('data-table')) return KIND.DATA_TABLE;
  if (name === 'button' || name === 'exp-button') return KIND.BUTTON;
  if (raw.isSymbol) return KIND.SYMBOL;
  if (Array.isArray(raw.children) && raw.children.length) return KIND.LAYOUT;
  return KIND.GENERIC;
}

/** First plain-text run of an HTML string, trimmed and clipped. */
function textOf(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/** @param {object} raw @param {string} kind @returns {string} */
function deriveLabel(raw, kind) {
  const props = raw.props || {};
  if (kind === KIND.FORM_FIELD && raw.field) {
    return raw.field.label || raw.field.name || raw.name || 'field';
  }
  if (kind === KIND.BUTTON) {
    return (
      props.label ||
      textOf(props.innerHTML) ||
      textOf(props['[innerHTML]']) ||
      'button'
    );
  }
  if (kind === KIND.SYMBOL) return raw.name || 'symbol';
  const cls = typeof props.className === 'string' ? props.className.trim() : '';
  if (cls) return `${raw.name} .${cls.split(/\s+/)[0]}`;
  return raw.name || 'node';
}

/**
 * Visibility verdict for a node.
 *  - always         — no visibility prop; renders unconditionally
 *  - static-visible — `isVisible` literal truthy
 *  - static-hidden  — `isVisible` literal false
 *  - bound          — `[isVisible]` expression; conditionally shown at runtime
 * @typedef {{ kind: string, expr?: string }} Visibility
 * @param {object} raw @returns {Visibility}
 */
export function getVisibility(raw) {
  const props = raw.props || {};
  if ('[isVisible]' in props) {
    return { kind: 'bound', expr: String(props['[isVisible]']) };
  }
  if ('isVisible' in props) {
    const v = props.isVisible;
    const hidden = v === false || v === 'false';
    return { kind: hidden ? 'static-hidden' : 'static-visible' };
  }
  return { kind: 'always' };
}

/**
 * Normalized tree node.
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: string,
 *   label: string,
 *   fieldName: string,
 *   visibility: Visibility,
 *   depth: number,
 *   raw: object,
 *   children: TreeNode[]
 * }} TreeNode
 */

/**
 * Build the normalized tree from a raw compiled-config `layout` root.
 * @param {object | null} rawRoot
 * @returns {TreeNode | null}
 */
export function buildTree(rawRoot) {
  let synthetic = 0;
  const visit = (raw, depth) => {
    const kind = detectKind(raw);
    const id = raw.id || raw._elementId || `__synthetic_${synthetic++}`;
    return {
      id,
      name: raw.name || '?',
      kind,
      label: deriveLabel(raw, kind),
      fieldName: (raw.field && raw.field.name) || '',
      visibility: getVisibility(raw),
      depth,
      raw,
      children: Array.isArray(raw.children)
        ? raw.children.map((c) => visit(c, depth + 1))
        : []
    };
  };
  return rawRoot ? visit(rawRoot, 0) : null;
}

/**
 * Count nodes and conditionally-bound nodes in a tree.
 * @param {TreeNode | null} root
 * @returns {{ total: number, bound: number, hidden: number }}
 */
export function summarize(root) {
  let total = 0;
  let bound = 0;
  let hidden = 0;
  const walk = (n) => {
    if (!n) return;
    total++;
    if (n.visibility.kind === 'bound') bound++;
    if (n.visibility.kind === 'static-hidden') hidden++;
    n.children.forEach(walk);
  };
  walk(root);
  return { total, bound, hidden };
}
