// Step classification by service identity (AD-02).
//
// A step's real service is `automationSystem` + `automationAPI` of the
// automation record it points at (`GET /automations/{automationId}`). The
// numeric `automationApiId` is env-local: sems-dev registers `db_service
// data.read` as 19, nsm documents `Database.SQL data.read` as 48. Classifying
// by numeric ids alone missed every SQL and echo step on sems.
//
// Identity sources, strongest first:
//   1. an injected `ServiceResolver` (online: lib/hydrator.ts builds one from
//      the env-scoped definition cache; offline/tests: from fixtures);
//   2. the wire's own names — V2 `serviceName`/`methodName`;
//   3. a per-env fast path of verified numeric apiIds / apiUuids.
// When none applies the step stays EXISTING_SERVICE: never guess SQL/SpEL,
// because the save guard only writes `sql`/`expression` into steps of that kind.

/** The service a step calls. `system` is the automation-system name (`db_service`), `api` the API label (`data.read`). */
export interface ServiceIdentity {
  system: string;
  api: string;
  /** automationSystem.label when it differs from the name (`Database.SQL` for `db_service`). */
  systemLabel?: string;
  /** automationAPI uuid, trimmed. */
  apiUuid?: string;
  /** automationAPI numeric id (env-local). */
  apiId?: number;
  /** Uuids of the service inputs that carry the SQL text (`produces: queryString`). */
  sqlInputUuids?: string[];
  /** input uuid/id → human label, for rendering step mappings. */
  inputLabels?: Record<string, string>;
}

/** What a V1/V2 step says about its service, before any lookup. */
export interface StepServiceRef {
  automationId?: number | string;
  automationApiId?: number | string;
  automationApiUuid?: string;
  categoryName?: string;
  serviceName?: string;
  methodName?: string;
}

export type ServiceResolver = (ref: StepServiceRef) => ServiceIdentity | null;

export interface ParseOptions {
  /** Environment the body came from; enables the verified numeric fast path. */
  env?: string;
  /** Online or fixture-backed service lookup (see lib/hydrator.ts:buildServiceResolver). */
  resolveService?: ServiceResolver;
}

export type StepFamily =
  | { kind: "SQL"; operation: string }
  | { kind: "SPEL_ECHO" }
  | { kind: "REDIS_GET" | "REDIS_SET" | "REDIS_REMOVE" }
  | { kind: "EXISTING_SERVICE" };

// ─── canonical mapping (derived from tests/fixtures/definitions + real-v2) ──

const SQL_SYSTEMS = new Set(["db_service", "database.sql"]);
const SQL_OPERATIONS: Record<string, string> = {
  "data.read": "read",
  select: "read",
  "data.add": "add",
  insert: "add",
  "data.update": "update",
  update: "update",
  "data.delete": "delete",
  delete: "delete",
  "schema.modify": "schema.modify",
  "data.schema.modify": "schema.modify",
};
const ECHO_SYSTEMS = new Set(["helpers.legacy"]);
const REDIS_SYSTEMS = new Set(["cache.redis"]);
const REDIS_KINDS: Record<string, "REDIS_GET" | "REDIS_SET" | "REDIS_REMOVE"> = {
  get: "REDIS_GET",
  set: "REDIS_SET",
  remove: "REDIS_REMOVE",
};

/** Map a service identity to the step family belz can decode/edit. */
export function classifyService(id: ServiceIdentity | null | undefined): StepFamily {
  if (!id) return { kind: "EXISTING_SERVICE" };
  const systems = [id.system, id.systemLabel].filter((s): s is string => !!s).map((s) => s.trim().toLowerCase());
  const api = (id.api ?? "").trim().toLowerCase();
  if (systems.some((s) => SQL_SYSTEMS.has(s))) {
    const operation = SQL_OPERATIONS[api];
    if (operation) return { kind: "SQL", operation };
  }
  if (systems.some((s) => ECHO_SYSTEMS.has(s)) && api === "echo") return { kind: "SPEL_ECHO" };
  if (systems.some((s) => REDIS_SYSTEMS.has(s))) {
    const k = REDIS_KINDS[api];
    if (k) return { kind: k };
  }
  return { kind: "EXISTING_SERVICE" };
}

// ─── verified per-env fast path ───────────────────────────────────────────
//
// Numeric apiIds and apiUuids are env-local, so each table is keyed by env
// name and only consulted for that env. sems-dev values are verified against
// the captured definitions (tests/fixtures/definitions, real-v1/real-v2
// pairs). The nsm values are the team-documented ids from
// ad-rest-api-step-types.md (the pre-AD-02 constants).

type Key = Pick<ServiceIdentity, "system" | "api">;
const k = (system: string, api: string): Key => ({ system, api });

const SEMS_DEV: { ids: Record<number, Key>; uuids: Record<string, Key> } = {
  ids: {
    19: k("db_service", "data.read"),
    20: k("db_service", "data.update"),
    21: k("db_service", "data.add"),
    6501: k("Helpers.Legacy", "echo"),
    6700: k("Cache.Redis", "get"),
    6701: k("Cache.Redis", "set"),
  },
  uuids: {
    "15805db3-0a4f-4f2a-80d8-c433a1ffeced": k("db_service", "data.read"),
    "3706a083-4647-4c2b-8391-1a80613b8bbc": k("db_service", "data.update"),
    "f5164443-9f04-4391-b2d1-fe0b8e00f5a9": k("db_service", "data.add"),
    "7cacda5d-186b-4e1b-aaf1-a8acb617f35b": k("db_service", "data.delete"),
    "424ffd4c9e0f55befc238dd999dab2d6": k("Helpers.Legacy", "echo"),
    "48cee4eb419d451c5397a5225c88c11c": k("Cache.Redis", "get"),
    "4954080a4640be01364a9b597ce2b82d": k("Cache.Redis", "set"),
  },
};

const NSM: { ids: Record<number, Key>; uuids: Record<string, Key> } = {
  ids: {
    48: k("Database.SQL", "data.read"),
    49: k("Database.SQL", "data.update"),
    893: k("Database.SQL", "data.add"),
    894: k("Database.SQL", "data.delete"),
    50: k("Database.SQL", "schema.modify"),
    21927: k("Helpers.Legacy", "echo"),
    22929: k("Cache.Redis", "get"),
    22930: k("Cache.Redis", "set"),
    22928: k("Cache.Redis", "remove"),
  },
  uuids: {},
};

const FAST_PATH: Record<string, { ids: Record<number, Key>; uuids: Record<string, Key> }> = {
  "sems-dev": SEMS_DEV,
  "nsm-dev": NSM,
  "nsm-qa": NSM,
  "nsm-uat": NSM,
};

/** Identity from the verified per-env tables, or null. */
export function fastPathIdentity(ref: StepServiceRef, env: string | undefined): ServiceIdentity | null {
  if (!env) return null;
  const table = FAST_PATH[env];
  if (!table) return null;
  const apiId = typeof ref.automationApiId === "number" ? ref.automationApiId : null;
  if (apiId !== null && table.ids[apiId]) return { ...table.ids[apiId]!, apiId };
  for (const u of [ref.automationApiUuid, typeof ref.automationApiId === "string" ? ref.automationApiId : undefined]) {
    const key = typeof u === "string" ? u.trim().toLowerCase() : "";
    if (key && table.uuids[key]) return { ...table.uuids[key]!, apiUuid: key };
  }
  return null;
}

/**
 * Resolve a step's identity: injected resolver → wire names → env fast path.
 * The V2 wire names (`serviceName` = system name, `methodName` = API label)
 * are portable and need no lookup.
 */
export function resolveStepIdentity(ref: StepServiceRef, opts: ParseOptions | undefined): ServiceIdentity | null {
  const resolved = opts?.resolveService?.(ref) ?? null;
  if (resolved) return resolved;
  if (ref.serviceName && ref.methodName) {
    return {
      system: ref.serviceName,
      api: ref.methodName,
      apiUuid: typeof ref.automationApiId === "string" ? ref.automationApiId.trim() : undefined,
    };
  }
  return fastPathIdentity(ref, opts?.env);
}
