// Cross-version helpers and constants used by V1 and V2 step parsers.
//
// The numeric IDs below are the V1 `automationApiId` values documented in
// expertly.coding.agents/Claude/docs-projects/Expertly/Automation_Designer/
// ad-rest-api-step-types.md. They are environment-agnostic (the core services
// use the same IDs across dev/qa/uat). If a new core service is added or an
// ID changes, update this file and the v1.ts step parser.

export const SHARED_STEP_CONSTANTS = {
  // Helpers.Legacy.echo — evaluates a SpEL expression and returns its value.
  ECHO_API_ID_V1: 21927,

  // Database.SQL — five data-plane operations.
  SQL_API_IDS_V1: {
    read: 48,
    update: 49,
    add: 893,
    del: 894,
    schemaModify: 50,
  },

  // Cache.Redis — three key-value operations.
  REDIS_GET_V1: 22929,
  REDIS_SET_V1: 22930,
  REDIS_REMOVE_V1: 22928,
} as const;

/** All V1 SQL API IDs as a lookup set. */
export const SQL_API_IDS_V1_SET = new Set<number>(
  Object.values(SHARED_STEP_CONSTANTS.SQL_API_IDS_V1),
);

/** Map a V1 SQL API ID to its logical operation name. */
export function sqlOperationForApiIdV1(apiId: number): string | null {
  const ids = SHARED_STEP_CONSTANTS.SQL_API_IDS_V1;
  if (apiId === ids.read) return "read";
  if (apiId === ids.update) return "update";
  if (apiId === ids.add) return "add";
  if (apiId === ids.del) return "delete";
  if (apiId === ids.schemaModify) return "schema.modify";
  return null;
}

export function isRedisApiIdV1(apiId: number): "REDIS_GET" | "REDIS_SET" | "REDIS_REMOVE" | null {
  if (apiId === SHARED_STEP_CONSTANTS.REDIS_GET_V1) return "REDIS_GET";
  if (apiId === SHARED_STEP_CONSTANTS.REDIS_SET_V1) return "REDIS_SET";
  if (apiId === SHARED_STEP_CONSTANTS.REDIS_REMOVE_V1) return "REDIS_REMOVE";
  return null;
}

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

/** Convenience string-getter that tolerates `undefined` and whitespace-only. */
export function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}
