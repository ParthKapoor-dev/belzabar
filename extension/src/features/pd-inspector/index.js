// PD Inspector orchestration.
//
// Resolves the published page, fetches its compiled config, builds the tree,
// and mounts the overlay. Published pages are Angular SPAs, so a lightweight
// URL watcher re-mounts the overlay when the route changes client-side.

import { getPageContext, fetchPageConfig } from './config.js';
import { buildTree } from './tree.js';
import { mountOverlay } from './overlay.js';

const EMPTY_CONFIG = {
  path: '',
  referencePageId: '',
  deployableId: '',
  pageVersionId: 0,
  layout: null,
  httpCount: 0
};

async function mountForCurrentUrl() {
  const ctx = getPageContext();
  if (!ctx) return;

  const existing = document.getElementById('pdi-host');
  if (existing) existing.remove();

  let config;
  try {
    config = await fetchPageConfig(ctx);
  } catch (err) {
    console.warn('[PD Inspector] config unavailable:', err && err.message);
    mountOverlay({ ctx, config: { ...EMPTY_CONFIG, path: ctx.path }, tree: null });
    return;
  }

  mountOverlay({ ctx, config, tree: buildTree(config.layout) });
}

/** Re-mount when the SPA changes route to a different /pages/ path. */
function watchNavigation() {
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    mountForCurrentUrl();
  }, 1500);
}

export function startPdInspector() {
  if (!getPageContext()) return;
  mountForCurrentUrl();
  watchNavigation();
}
