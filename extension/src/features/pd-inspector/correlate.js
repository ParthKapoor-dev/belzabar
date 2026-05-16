// DOM <-> config-node correlation.
//
// The expertly runtime renders each config node as an `exp-*` custom element
// (loops unrolled, symbols inlined), so a hovered DOM element maps to a config
// node only by tiers:
//   - component kind  — always exact, straight from the `exp-*` tag
//   - form fields     — exact: the inner <input name> equals the config
//                       node's `field.name`
//   - everything else — best-effort: kind + how many config nodes share it

import { KIND } from './tree.js';

/** `exp-*` tag -> config node kind. */
const KIND_BY_TAG = {
  'exp-field': KIND.FORM_FIELD,
  'exp-form-field': KIND.FORM_FIELD,
  'exp-data-table': KIND.DATA_TABLE,
  'exp-button': KIND.BUTTON,
  'exp-layout': KIND.LAYOUT,
  'exp-layout-slot': KIND.LAYOUT,
  'exp-slot': KIND.LAYOUT
};

/** Climb to the nearest `exp-*` element, self included. */
export function nearestExpElement(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase();
    if (tag.startsWith('exp-')) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** Read the form-control `name` inside an exp-field, if any. */
function fieldNameOf(expEl) {
  const control = expEl.querySelector('input[name], select[name], textarea[name]');
  return control ? control.getAttribute('name') || '' : '';
}

/** Index a normalized tree by `field.name` for exact field lookup. */
export function indexByFieldName(root) {
  const index = new Map();
  const walk = (n) => {
    if (!n) return;
    if (n.fieldName) index.set(n.fieldName, n);
    n.children.forEach(walk);
  };
  walk(root);
  return index;
}

/** Count config nodes per kind, for the best-effort tier. */
export function countByKind(root) {
  const counts = {};
  const walk = (n) => {
    if (!n) return;
    counts[n.kind] = (counts[n.kind] || 0) + 1;
    n.children.forEach(walk);
  };
  walk(root);
  return counts;
}

/**
 * Identify the PD component under a DOM element.
 * @param {Element} el  the raw event target
 * @param {{ fieldIndex: Map, kindCounts: object }} ctx
 * @returns {{
 *   expEl: Element,
 *   tag: string,
 *   kind: string,
 *   fieldName: string,
 *   node: object | null,
 *   tier: 'exact' | 'kind',
 *   peers: number
 * } | null}
 */
export function identify(el, ctx) {
  const expEl = nearestExpElement(el);
  if (!expEl) return null;

  const tag = expEl.tagName.toLowerCase();
  const kind = KIND_BY_TAG[tag] || KIND.GENERIC;

  let fieldName = '';
  let node = null;
  if (kind === KIND.FORM_FIELD) {
    fieldName = fieldNameOf(expEl);
    if (fieldName) node = ctx.fieldIndex.get(fieldName) || null;
  }

  return {
    expEl,
    tag,
    kind,
    fieldName,
    node,
    tier: node ? 'exact' : 'kind',
    peers: ctx.kindCounts[kind] || 0
  };
}
