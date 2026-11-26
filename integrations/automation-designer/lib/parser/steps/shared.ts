// Cross-version helpers used by V1 and V2 step parsers.
//
// Service identification (which step is SQL / SpEL echo / Redis) lives in
// ./classify.ts — numeric apiIds are env-local and only used there as a
// verified per-env fast path.

/**
 * Walk a V1 mapping tree (which can nest OBJECT → CUSTOM / DROPDOWN mappings)
 * and yield every mapping in depth-first order. Used by the V1 step parser to
 * locate base64 SQL payloads and by the SQL TUI to walk compound inputs.
 */
export function* walkMappingTree<T extends { mappings?: T[] }>(roots: T[] | undefined): Generator<T> {
  if (!Array.isArray(roots)) return;
  for (const m of roots) {
    yield m;
    if (m.mappings && Array.isArray(m.mappings)) {
      yield* walkMappingTree(m.mappings as T[]);
    }
  }
}

/**
 * Find the first mapping in a tree whose automationUserInputId matches.
 * Used to pluck Redis/SQL sub-inputs by their known IDs.
 */
export function findMappingByInputId<T extends { automationUserInputId?: number; mappings?: T[] }>(
  roots: T[] | undefined,
  id: number,
): T | null {
  for (const m of walkMappingTree(roots)) {
    if (m.automationUserInputId === id) return m;
  }
  return null;
}

/** The V2 loop type of a V1 "each" loop (over a list). */
export const EACH_LOOP = "LOOP_EXECUTION_ON_INPUT_OUTPUT";

/** A V1 step's loop source when it is the older editor's form (source only, `repeatStepExecution` unset). */
export function legacyLoopSource(svc: Record<string, unknown>): string | undefined {
  const src = typeof svc.loopExecutionSource === "string" ? svc.loopExecutionSource.trim() : "";
  if (!src || svc.repeatStepExecution === true || svc.repeatStepExecution === false) return undefined;
  return src;
}
