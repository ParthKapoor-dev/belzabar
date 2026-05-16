// PD Inspector content-script engine.
//
// Runs on published /pages/* pages. It fetches the page + component configs,
// builds the exact component-nesting tree and the best-effort DOM correlation,
// and answers commands from the DevTools "PD Inspector" panel. Inspect mode
// (point at the page, identify the owning PD component) runs here because the
// highlighting must happen on the page.
//
// Messaging: the panel calls in via chrome.tabs.sendMessage; the engine pushes
// pick events back out via chrome.runtime.sendMessage. All messages are tagged
// `ns: 'pd'`.

import { getPageContext, fetchPageConfig, fetchComponentGraph } from './config.js';
import { buildComponentTree } from './componentTree.js';
import { buildAnchors, createCorrelator } from './correlate.js';
import { createHighlighter } from './highlight.js';

/** @type {{status:string, pageInfo?:object, componentTree?:object, correlation?:object, error?:string}} */
let STATE = { status: 'loading' };
let correlator = null;
let highlighter = null;
let inspecting = false;

/** Drop the heavy `raw` config object from a node tree before messaging. */
function stripNodeTree(node) {
  if (!node) return null;
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    label: node.label,
    fieldName: node.fieldName,
    visibility: node.visibility,
    depth: node.depth,
    children: node.children.map(stripNodeTree)
  };
}

/** Make the component tree structured-clone friendly (no `raw`). */
function serializeComponentTree(node) {
  return {
    name: node.name,
    isPage: node.isPage,
    referencePageId: node.referencePageId,
    nodeTree: stripNodeTree(node.nodeTree),
    nodeSummary: node.nodeSummary,
    error: node.error,
    children: node.children.map(serializeComponentTree)
  };
}

async function build(ctx) {
  STATE = { status: 'loading' };
  const pageConfig = await fetchPageConfig(ctx);
  const graph = await fetchComponentGraph(ctx, pageConfig.layout);
  const componentTree = buildComponentTree(pageConfig, graph);
  const anchors = buildAnchors(pageConfig, graph);
  correlator = createCorrelator(anchors);

  STATE = {
    status: 'ready',
    pageInfo: {
      host: ctx.host,
      path: pageConfig.path,
      env: ctx.env,
      referencePageId: pageConfig.referencePageId,
      pageVersionId: pageConfig.pageVersionId,
      componentCount: componentTree.children.length,
      correlation: {
        confidence: correlator.confidence,
        expectedAnchors: correlator.expectedAnchors,
        domAnchors: correlator.domAnchors
      }
    },
    componentTree: serializeComponentTree(componentTree)
  };
}

// ---- inspect mode ----------------------------------------------------------

const CONFIDENCE_NOTE = {
  exact: '',
  approx: '  (approx — conditional regions on page)',
  low: '  (low confidence — may be off)'
};

function onMove(e) {
  if (!correlator) return;
  const hit = correlator.chainFor(e.target);
  if (!hit) {
    highlighter.hide();
    return;
  }
  if (hit.chain) {
    const inner = hit.chain[hit.chain.length - 1];
    const owner = hit.chain.length > 1 ? inner : `${inner} (page-level)`;
    highlighter.show(
      [hit.anchorEl],
      owner + (CONFIDENCE_NOTE[hit.confidence] || ''),
      hit.chain.join('  ›  ')
    );
  } else {
    highlighter.show([hit.anchorEl], 'component undetermined', `<${hit.anchorTag}>`);
  }
}

function onClick(e) {
  if (!correlator) return;
  const hit = correlator.chainFor(e.target);
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  chrome.runtime.sendMessage({
    ns: 'pd',
    type: 'pick',
    chain: hit.chain,
    anchorTag: hit.anchorTag
  });
}

function setInspect(on) {
  if (on === inspecting) return;
  inspecting = on;
  if (on) {
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
  } else {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    highlighter.hide();
  }
}

// ---- panel command handling ------------------------------------------------

function handleCommand(msg, sendResponse) {
  switch (msg.cmd) {
    case 'getState':
      sendResponse(STATE);
      return;
    case 'setInspect':
      setInspect(!!msg.on);
      sendResponse({ ok: true, inspecting });
      return;
    case 'highlightComponent': {
      if (!correlator) {
        sendResponse({ ok: false, reason: 'not ready' });
        return;
      }
      const els = correlator.elementsForComponent(msg.name);
      if (els.length) {
        els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        highlighter.show(els, msg.name, `${els.length} region(s)`);
      } else {
        highlighter.hide();
      }
      sendResponse({ ok: true, count: els.length });
      return;
    }
    case 'clearHighlight':
      highlighter.hide();
      sendResponse({ ok: true });
      return;
    default:
      sendResponse({ ok: false, reason: 'unknown command' });
  }
}

// ---- lifecycle -------------------------------------------------------------

export function startEngine() {
  const ctx = getPageContext();
  if (!ctx) return;

  highlighter = createHighlighter();

  build(ctx).catch((err) => {
    STATE = { status: 'error', error: String((err && err.message) || err) };
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.ns !== 'pd' || !msg.cmd) return false;
    handleCommand(msg, sendResponse);
    return true; // responses may be produced synchronously, but keep the port open
  });

  // Published pages are SPAs — rebuild when the route changes.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    setInspect(false);
    const next = getPageContext();
    if (next) {
      build(next).catch((err) => {
        STATE = { status: 'error', error: String((err && err.message) || err) };
      });
    }
  }, 1500);
}
