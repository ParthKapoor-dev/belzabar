// Shared helpers for the Chain Inspector DevTools panel.
//
// The Automation Designer "chain" fetch API returns the full method definition,
// so the human-readable method name can be pulled straight out of the response
// body — no extra requests needed.

const CHAIN_FETCH_RE = /\/rest\/api\/automation\/chain\/(?:v2\/)?([0-9a-f]{32})\b/i;

/**
 * Match an AD chain *definition fetch* URL (V1 `/chain/<uuid>` or V2
 * `/chain/v2/<uuid>`). Deliberately does NOT match `/chain/execute/...`,
 * `/chain/test/...`, `/chain/export/...` etc. — those carry no definition.
 *
 * @param {string} url
 * @returns {{ uuid: string } | null}
 */
export function isChainFetchUrl(url) {
  if (typeof url !== 'string') return null;
  const m = CHAIN_FETCH_RE.exec(url);
  return m ? { uuid: m[1].toLowerCase() } : null;
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
 * Extract the method name from a chain fetch response body. Handles V1 (a
 * stringified `jsonDefinition`) and V2 (flat / `metadata`) shapes defensively.
 *
 * @param {string} bodyText
 * @returns {string | null}
 */
export function extractMethodNameFromChainResponse(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return null;
  let obj;
  try {
    obj = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  // Top-level / V2 metadata shapes.
  const direct = nameFromDefinition(obj);
  if (direct) return direct;

  // V1: jsonDefinition holds the real method JSON (often stringified).
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
