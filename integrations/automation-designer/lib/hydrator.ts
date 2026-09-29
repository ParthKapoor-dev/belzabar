import { join } from "path";
import { Cache, BELZ_CONFIG_DIR } from "@belzabar/core";
import * as v1 from "./api/v1";
import type { V1AutomationDefinition, V1AutomationUserInput, V1RawMethodResponse, V1ServiceStep } from "./types/v1-wire";
import {
  type ServiceIdentity,
  type ServiceResolver,
  type StepServiceRef,
} from "./parser/steps/classify";

const definitionCache = new Cache<V1AutomationDefinition>({
  dir: join(BELZ_CONFIG_DIR, "cache", "definitions"),
  // Env-scoped by core `Cache` (automation ids are env-local). Flat 1 h TTL for
  // every id — nothing guarantees any id shape is immutable.
  ttlMs: 60 * 60 * 1000,
});

export class ServiceHydrator {
  /** Wire payloads carry `automationId` as a number; callers may pass either. */
  static async getDefinition(automationIdRaw: string | number): Promise<V1AutomationDefinition | null> {
    const automationId = String(automationIdRaw).trim();
    const cached = await definitionCache.load(automationId);
    if (cached) return cached;

    try {
      const data = await v1.fetchAutomationDefinition(automationId);
      if (!data) return null;
      await definitionCache.save(automationId, data);
      return data;
    } catch {
      return null;
    }
  }

  static async ensureCached(automationId: string | number): Promise<void> {
    await this.getDefinition(automationId);
  }

  static findInputLabel(
    def: V1AutomationDefinition,
    inputId: string | number,
  ): { label: string; encoding?: string } | null {
    if (!def.automationAPI.automationUserInputs) return null;

    const findRecursive = (
      inputs: V1AutomationUserInput[],
    ): { label: string; encoding?: string } | null => {
      for (const input of inputs) {
        if (String(input.id) === String(inputId)) {
          return { label: input.label, encoding: input.encodingType };
        }
        if (input.automationUserInputs) {
          const found = findRecursive(input.automationUserInputs);
          if (found) return found;
        }
      }
      return null;
    };

    return findRecursive(def.automationAPI.automationUserInputs);
  }

  static flattenInputs(def: V1AutomationDefinition): {
    id: string;
    label: string;
    required: boolean;
    encoding?: string;
    orderIndex: number;
    depth: number;
    hidden: boolean;
  }[] {
    const flattened: {
      id: string;
      label: string;
      required: boolean;
      encoding?: string;
      orderIndex: number;
      depth: number;
      hidden: boolean;
    }[] = [];

    if (!def.automationAPI.automationUserInputs) return flattened;

    const traverse = (inputs: V1AutomationUserInput[], depth = 0) => {
      for (const input of inputs) {
        const hasLabel = input.label && input.label.trim().length > 0;
        const nextDepth = hasLabel ? depth + 1 : depth;

        flattened.push({
          id: input.id,
          label: input.label,
          required: input.optional === false,
          encoding: input.encodingType,
          orderIndex: input.orderIndex || 0,
          depth: depth,
          hidden: input.showOnSDUi === false,
        });

        if (input.automationUserInputs) {
          traverse(input.automationUserInputs, nextDepth);
        }
      }
    };

    traverse(def.automationAPI.automationUserInputs);
    return flattened.sort((a, b) => a.orderIndex - b.orderIndex);
  }
}

// ─── Step service identity ────────────────────────────────────────

/** Service identity of an automation record (`GET /automations/{automationId}`). */
export function identityFromDefinition(def: V1AutomationDefinition | null | undefined): ServiceIdentity | null {
  const api = def?.automationAPI;
  const sys = api?.automationSystem;
  if (!api || !sys) return null;
  const system = (sys.name ?? sys.label ?? "").trim();
  const label = (api.label ?? "").trim();
  if (!system || !label) return null;
  const sqlInputUuids: string[] = [];
  const inputLabels: Record<string, string> = {};
  const walk = (inputs: V1AutomationUserInput[] | undefined) => {
    for (const i of inputs ?? []) {
      const uuid = typeof i.uuid === "string" ? i.uuid.trim() : "";
      if (i.produces === "queryString" && uuid) sqlInputUuids.push(uuid);
      const text = typeof i.label === "string" && i.label.trim() ? i.label.trim() : i.produces;
      if (text) {
        if (uuid) inputLabels[uuid] = text;
        if (i.id != null) inputLabels[String(i.id)] = text;
      }
      walk(i.automationUserInputs);
    }
  };
  walk(api.automationUserInputs);
  const identity: ServiceIdentity = { system, api: label, inputLabels };
  if (sys.label && sys.label.trim() !== system) identity.systemLabel = sys.label.trim();
  if (typeof api.uuid === "string" && api.uuid.trim()) identity.apiUuid = api.uuid.trim();
  if (typeof api.id === "number") identity.apiId = api.id;
  if (sqlInputUuids.length > 0) identity.sqlInputUuids = sqlInputUuids;
  return identity;
}

/** A resolver over a fixed `automationId → identity` table (online result or offline fixtures). */
export function resolverFromTable(table: ReadonlyMap<string, ServiceIdentity>): ServiceResolver {
  return (ref: StepServiceRef) => (ref.automationId == null ? null : table.get(String(ref.automationId).trim()) ?? null);
}

interface ServiceResolution {
  resolveService: ServiceResolver;
  /** automationIds whose definition could not be fetched (their steps stay EXISTING_SERVICE). */
  unresolved: string[];
}

const LOOKUP_CONCURRENCY = 6;

/**
 * Look up every existing-service step of a V1 body so the parser can classify
 * it by service. Every distinct automationId goes through the
 * env-scoped definition cache (one GET each, cached 1 h): the definition also
 * names the SQL query input, which the numeric fast path cannot. A failed
 * lookup falls back to the verified per-env fast path in the parser
 * (`env` is passed on to parseV1Method by the caller).
 */
export async function buildServiceResolver(
  raw: V1RawMethodResponse,
  deps: { getDefinition?: (automationId: string) => Promise<V1AutomationDefinition | null> } = {},
): Promise<ServiceResolution> {
  const getDefinition = deps.getDefinition ?? ((id: string) => ServiceHydrator.getDefinition(id));
  const table = new Map<string, ServiceIdentity>();
  const unresolved: string[] = [];
  const pending = new Set<string>();
  for (const step of v1Steps(raw)) {
    if (step.activeTab?.id === "customCode" || step.automationId == null) continue;
    pending.add(String(step.automationId).trim());
  }
  const queue = [...pending];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const identity = identityFromDefinition(await getDefinition(id).catch(() => null));
      if (identity) table.set(id, identity);
      else unresolved.push(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, worker));
  return { resolveService: resolverFromTable(table), unresolved: unresolved.sort() };
}

function v1Steps(raw: V1RawMethodResponse): V1ServiceStep[] {
  if (typeof raw.jsonDefinition !== "string" || raw.jsonDefinition.length === 0) return [];
  try {
    const inner = JSON.parse(raw.jsonDefinition) as { services?: V1ServiceStep[] };
    return Array.isArray(inner.services) ? inner.services : [];
  } catch {
    return [];
  }
}
