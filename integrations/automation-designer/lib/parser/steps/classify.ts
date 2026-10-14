// Step classification by service identity.
//
// A step's real service is `automationSystem` + `automationAPI` of the
// automation record it points at (`GET /automations/{automationId}`). The
// numeric `automationApiId` is env-local: the same `data.read` API has a
// different id on every environment, so numeric ids are never classified by
// value (there are no built-in per-env tables).
//
// Identity sources, strongest first:
//   1. an injected `ServiceResolver` (online: lib/hydrator.ts builds one from
//      the env-scoped definition cache; offline/tests: from fixtures);
//   2. the wire's own names — V2 `serviceName`/`methodName`.
// When neither applies the step stays EXISTING_SERVICE: never guess SQL/SpEL,
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
  /** Environment the body came from (informational; ids are env-local). */
  env?: string;
  /** Online or fixture-backed service lookup (see lib/hydrator.ts:buildServiceResolver). */
  resolveService?: ServiceResolver;
}

type StepFamily =
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

/** Map a service identity to the step family wi-impl can decode/edit. */
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

/**
 * Resolve a step's identity: injected resolver → wire names.
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
  return null;
}
