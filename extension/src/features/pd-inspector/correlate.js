// Best-effort DOM <-> component correlation.
//
// The expertly runtime leaves no per-component marker in the rendered DOM, so
// a component boundary can only be inferred. The reliable anchors are
// `exp-form-builder` and `exp-data-table`: the runtime renders them 1:1 with
// their config nodes and in document order. Walking the (recursively expanded)
// config in document order yields the *expected* anchor sequence, each tagged
// with the component chain that produced it.
//
// Runtime conditionals (`[isVisible]`) mean some expected anchors are not
// actually rendered, so the live DOM anchors are a *subsequence* of the
// expected ones. We align by dropping conditionally-gated anchors first and
// report an honest confidence:
//   exact  — expected count == DOM count, 1:1 zip
//   approx — the shortfall is fully explained by conditional anchors
//   low    — an unexplained shortfall remains; the mapping may be off

import { isSymbolRef } from './config.js';

const ANCHOR_TAGS = ['exp-form-builder', 'exp-data-table'];

/** True when a node gates visibility on a runtime expression. */
function isConditional(node) {
  return !!(node && node.props && '[isVisible]' in node.props);
}

/**
 * Walk the expanded config, collecting an anchor record for each
 * form-builder / data-table in document order.
 * @returns {{ formBuilders: Anchor[], dataTables: Anchor[] }}
 *   Anchor = { chain: string[], conditional: boolean }
 */
export function buildAnchors(pageConfig, graph) {
  const formBuilders = [];
  const dataTables = [];

  const walk = (node, chain, conditional) => {
    if (!node || typeof node !== 'object') return;
    const gated = conditional || isConditional(node);
    const name = String(node.name || '').toLowerCase();
    if (name === 'exp-form-builder') formBuilders.push({ chain, conditional: gated });
    else if (name === 'exp-data-table') dataTables.push({ chain, conditional: gated });

    if (isSymbolRef(node)) {
      if (chain.includes(node.name)) return; // cycle guard
      const cc = graph.get(node.name);
      if (cc && cc.layout) walk(cc.layout, chain.concat(node.name), gated);
      return;
    }
    (node.children || []).forEach((c) => walk(c, chain, gated));
  };

  walk(pageConfig.layout, [pageConfig.path], false);
  return { formBuilders, dataTables };
}

/**
 * Align an expected anchor sequence to a (shorter or equal) DOM count.
 * Drops conditionally-gated anchors first.
 * @returns {{ chains: (string[]|null)[], confidence: 'exact'|'approx'|'low' }}
 *   chains[i] is the component chain for the i-th DOM anchor.
 */
function align(expected, domCount) {
  const drop = expected.length - domCount;
  if (drop === 0) {
    return { chains: expected.map((e) => e.chain), confidence: 'exact' };
  }
  if (drop < 0) {
    // DOM has anchors the config did not predict (loops, etc.) — pad with null.
    const chains = expected.map((e) => e.chain);
    while (chains.length < domCount) chains.push(null);
    return { chains, confidence: 'low' };
  }
  let budget = drop;
  const kept = [];
  for (const e of expected) {
    if (budget > 0 && e.conditional) {
      budget--;
      continue;
    }
    kept.push(e);
  }
  // Not enough conditional anchors to explain the shortfall — drop the tail.
  while (kept.length > domCount) kept.pop();
  return {
    chains: kept.map((e) => e.chain),
    confidence: budget === 0 ? 'approx' : 'low'
  };
}

/** Climb to the nearest anchor (form-builder / data-table) element. */
function nearestAnchorEl(el) {
  let cur = el;
  while (cur && cur.nodeType === 1) {
    if (ANCHOR_TAGS.includes(cur.tagName.toLowerCase())) return cur;
    cur = cur.parentElement;
  }
  return null;
}

const RANK = { exact: 0, approx: 1, low: 2 };

/**
 * Build a correlator over the current DOM.
 * @param {{ formBuilders: object[], dataTables: object[] }} anchors
 */
export function createCorrelator(anchors) {
  const domFB = [...document.querySelectorAll('exp-form-builder')];
  const domDT = [...document.querySelectorAll('exp-data-table')];

  const fb = align(anchors.formBuilders, domFB.length);
  const dt = align(anchors.dataTables, domDT.length);
  const confidence =
    RANK[fb.confidence] >= RANK[dt.confidence] ? fb.confidence : dt.confidence;

  function chainFor(el) {
    const anchor = nearestAnchorEl(el);
    if (!anchor) return null;
    const tag = anchor.tagName.toLowerCase();
    const chain =
      tag === 'exp-form-builder'
        ? fb.chains[domFB.indexOf(anchor)]
        : dt.chains[domDT.indexOf(anchor)];
    return { anchorEl: anchor, anchorTag: tag, chain: chain || null, confidence };
  }

  /** Live DOM anchor elements owned by a component (for highlighting). */
  function elementsForComponent(name) {
    const out = [];
    fb.chains.forEach((chain, i) => {
      if (chain && chain.includes(name) && domFB[i]) out.push(domFB[i]);
    });
    dt.chains.forEach((chain, i) => {
      if (chain && chain.includes(name) && domDT[i]) out.push(domDT[i]);
    });
    return out;
  }

  return {
    confidence,
    expectedAnchors: anchors.formBuilders.length + anchors.dataTables.length,
    domAnchors: domFB.length + domDT.length,
    chainFor,
    elementsForComponent
  };
}
