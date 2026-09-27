// Binding / AD-method / symbol extractors — shared helpers.
//
// Kept separate from the node walker because these operate on the raw stringified
// configuration (fast regex passes) rather than the parsed tree.

export function cleanAdId(url: string): string | null {
  const pattern = /\/rest\/api\/automation\/chain\/execute\/([a-zA-Z0-9-]+)/;
  const match = url.match(pattern);
  return match?.[1] ?? null;
}

/**
 * Every `{%varName%}` reference in the stringified config. De-duped.
 * Used by the validator for ORPHAN_BINDING + UNUSED_VARIABLE and by `--var-graph`.
 */
export function extractBindingReferences(configStr: string): string[] {
  const seen = new Set<string>();
  const regex = /\{%([^%]+)%\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(configStr)) !== null) {
    const ref = match[1];
    if (ref) seen.add(ref);
  }
  return Array.from(seen);
}
