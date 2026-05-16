// Published-page config fetch.
//
// A published app page lives at /pages/<path>. The expertly runtime renders it
// from a compiled Page Designer config, which is served (cookie-authed,
// same-origin) by the deployable endpoint below — so the content script can
// fetch the very config the page rendered from, no MAIN-world bridge needed.

/**
 * Page Designer context derived from the current published-page URL.
 * @typedef {{ host: string, path: string, env: string }} PageContext
 */

/**
 * Parsed deployable config for the current page.
 * @typedef {{
 *   path: string,
 *   referencePageId: string,
 *   deployableId: string,
 *   pageVersionId: number,
 *   layout: object | null,
 *   httpCount: number
 * }} PageConfig
 */

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
 * Fetch and parse the compiled config for a published page.
 * @param {PageContext} ctx
 * @returns {Promise<PageConfig>}
 */
export async function fetchPageConfig(ctx) {
  const url =
    '/rest/api/public/pagedesigner/deployable/pages?pageType=ALL' +
    `&domain=${encodeURIComponent(ctx.host)}` +
    `&path=${encodeURIComponent(ctx.path)}`;

  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`config fetch failed (${res.status})`);

  const json = await res.json();
  const deployed = json && json.deployedPages && json.deployedPages[0];
  if (!deployed) throw new Error('no deployed page for this path');

  let compiled;
  try {
    compiled = JSON.parse(deployed.compiledConfig);
  } catch {
    throw new Error('could not parse compiledConfig');
  }

  return {
    path: deployed.path || ctx.path,
    referencePageId: deployed.referencePageId || '',
    deployableId: deployed.deployableId || '',
    pageVersionId: deployed.pageVersionId || 0,
    layout: compiled.layout || null,
    httpCount: Array.isArray(compiled.http) ? compiled.http.length : 0
  };
}
