// Shared helpers for the Chain Inspector.
//
// The Automation Designer "chain" API is hit two ways:
//   - definition fetch  GET /rest/api/automation/chain[/v2]/<uuid>
//   - execution         POST /rest/api/automation/chain/[test/]execute/<uuid>
// A definition fetch returns the full method definition, so the human-readable
// method name can be read straight out of that response body.

const CHAIN_PATH_RE = /\/rest\/api\/automation\/chain\//i;
const EXECUTE_RE = /\/chain\/(?:test\/)?execute\//i;
const UUID_GLOBAL_RE = /[0-9a-f]{32}/gi;

/**
 * Classify an AD chain request URL.
 *
 * @param {string} url
 * @returns {{ uuid: string, kind: 'fetch' | 'execute', version: 'v1' | 'v2' } | null}
 */
export function classifyChainUrl(url) {
  if (typeof url !== 'string' || !CHAIN_PATH_RE.test(url)) return null;
  const path = url.split('?')[0];
  const found = path.match(UUID_GLOBAL_RE);
  if (!found || found.length === 0) return null;
  return {
    uuid: found[found.length - 1].toLowerCase(),
    kind: EXECUTE_RE.test(url) ? 'execute' : 'fetch',
    version: /\/chain\/v2\//i.test(url) ? 'v2' : 'v1'
  };
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function nameFromDefinition(def) {
  if (!def || typeof def !== 'object') return null;
  return firstString(
    def.name,
    def.methodName,
    def.metadata && def.metadata.name,
    def.metadata && def.metadata.methodName
  );
}

/**
 * Extract the method name from a chain definition-fetch response. Accepts the
 * raw response (a JSON string or an already-parsed object) and handles V1
 * (stringified `jsonDefinition`) and V2 (`metadata`) shapes defensively.
 *
 * @param {string | object} body
 * @returns {string | null}
 */
export function extractMethodNameFromChainResponse(body) {
  let obj = body;
  if (typeof body === 'string') {
    if (!body.trim()) return null;
    try {
      obj = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const direct = nameFromDefinition(obj);
  if (direct) return direct;

  let def = obj.jsonDefinition;
  if (typeof def === 'string') {
    try {
      def = JSON.parse(def);
    } catch {
      def = null;
    }
  }
  return nameFromDefinition(def);
}
