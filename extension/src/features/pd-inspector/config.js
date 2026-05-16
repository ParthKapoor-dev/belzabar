// Published-page + component config fetch.
//
// A published app page (/pages/<path>) renders from a compiled Page Designer
// config. That config embeds PD *components* (symbols) by name; each component
// has its own compiled config, fetched recursively here so the panel can show
// the full component-nesting tree.
//
// Everything is served cookie-authed, same-origin, by the deployable endpoint.

const DEPLOYABLE = '/rest/api/public/pagedesigner/deployable/pages';

/** @typedef {{ host: string, path: string, env: string }} PageContext */

/** Pull the env slug out of a verifi/expertly host (e.g. "nsm-dev"). */
function envFromHost(host) {
  const m = host.match(/^([a-z0-9-]+)\./i);
  return m ? m[1] : host;
}

/**
 * Read the published-page context from `location`, or null when the current
 * URL is not a /pages/ app page.
 * @returns {PageContext | null}
 */
export function getPageContext() {
  const m = location.pathname.match(/^\/pages\/(.+?)\/?$/);
  if (!m) return null;
  return { host: location.host, path: m[1], env: envFromHost(location.host) };
}

/**
 * A symbol *reference* — where a page/component embeds another component.
 * Distinct from a component *definition* root, which also carries `isSymbol`
 * but has children (its actual content). References are childless leaves.
 */
export function isSymbolRef(n) {
  return !!(
    n &&
    n.isSymbol &&
    n.name &&
    !(n.children && n.children.length)
  );
}

/** Names of every embedded-component reference in a layout, in document order. */
export function collectSymbolNames(layoutRoot) {
  const names = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (isSymbolRef(n)) names.push(n.name);
    (n.children || []).forEach(walk);
  };
  walk(layoutRoot);
  return names;
}

/**
 * Compiled config for one published page.
 * @typedef {{
 *   path: string,
 *   referencePageId: string,
 *   pageVersionId: number,
 *   layout: object | null
 * }} PageConfig
 */

/** Fetch + parse the compiled config for the current published page. */
export async function fetchPageConfig(ctx) {
  const url =
    `${DEPLOYABLE}?pageType=ALL` +
    `&domain=${encodeURIComponent(ctx.host)}` +
    `&path=${encodeURIComponent(ctx.path)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`page config fetch failed (${res.status})`);

  const json = await res.json();
  const deployed = json && json.deployedPages && json.deployedPages[0];
  if (!deployed) throw new Error('no deployed page for this path');

  const compiled = JSON.parse(deployed.compiledConfig);
  return {
    path: deployed.path || ctx.path,
    referencePageId: deployed.referencePageId || '',
    pageVersionId: deployed.pageVersionId || 0,
    layout: compiled.layout || null
  };
}

/**
 * Compiled config for one PD component.
 * @typedef {{
 *   name: string,
 *   referencePageId: string,
 *   layout: object | null,
 *   error?: string
 * }} ComponentConfig
 */

/** Fetch + parse one PD component's compiled config by name. */
export async function fetchComponentConfig(ctx, name) {
  const url =
    `${DEPLOYABLE}?pageType=COMPONENT` +
    `&domain=${encodeURIComponent(ctx.host)}` +
    `&path=${encodeURIComponent(name)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`component fetch failed (${res.status})`);

  const json = await res.json();
  const deployed = json && json.deployedPages && json.deployedPages[0];
  if (!deployed) throw new Error(`component not found: ${name}`);

  const compiled = JSON.parse(deployed.compiledConfig);
  return {
    name: deployed.path || name,
    referencePageId: deployed.referencePageId || '',
    layout: compiled.layout || null
  };
}

/**
 * Recursively fetch every PD component embedded (directly or transitively) in
 * a page. Returns a name -> ComponentConfig map. A failed fetch is recorded as
 * a stub so one bad component cannot break the whole graph.
 *
 * @param {PageContext} ctx
 * @param {object} pageLayout  the page's compiled-config layout root
 * @returns {Promise<Map<string, ComponentConfig>>}
 */
export async function fetchComponentGraph(ctx, pageLayout) {
  const map = new Map();
  const queue = collectSymbolNames(pageLayout);

  while (queue.length) {
    const name = queue.shift();
    if (map.has(name)) continue;
    let cfg = null;
    let lastErr = null;
    // One retry — rapid sequential fetches occasionally drop transiently.
    for (let attempt = 0; attempt < 2 && !cfg; attempt++) {
      try {
        cfg = await fetchComponentConfig(ctx, name);
      } catch (err) {
        lastErr = err;
      }
    }
    if (cfg) {
      map.set(name, cfg);
      for (const child of collectSymbolNames(cfg.layout)) {
        if (!map.has(child)) queue.push(child);
      }
    } else {
      map.set(name, {
        name,
        referencePageId: '',
        layout: null,
        error: String((lastErr && lastErr.message) || lastErr)
      });
    }
  }
  return map;
}
