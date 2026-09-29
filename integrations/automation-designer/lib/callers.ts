// `ad callers <uuid>` (Stage 7.6): a reverse index — which AD methods (and,
// with --pd, which PD pages / components) call a given method. Read-only.
//
// Target identity: the method's own automation-API uuid (V2 `automationApiId`)
// and its draft/published counterpart's, plus — from child-info on the
// published API — the numeric API id, API uuid and published chain uuid.
// V2 steps reference a callee by automationAPIId (uuid) and serviceName /
// methodName; V1 listing steps by `automationApiUuid` or the env-local numeric
// `automationApiId`; PD httpRequests by `/chain/execute/<chainUuid>`.
//
// Scope (cheap by default, honest about coverage):
//   - Every method in the method index (schema 2) is matched on its indexed
//     `calls` refs — instant, env-wide.
//   - Steps the listing only identifies by numeric `automationId` ("opaque")
//     need the method's V2 body. Those are read (and cached per
//     `<uuid>@<updatedOn>`, env-scoped) for the "deep" categories only: the
//     target's own category, `--category a,b`, or all with `--all`. Methods
//     outside the deep scope that still have opaque steps are counted in
//     `coverage.unscannedMethods` — they MAY hide callers.
//   - `--pd`: PD PAGE drafts + components are listed with their configuration
//     (2 list calls) and every `/chain/execute/<uuid>` httpRequest is matched;
//     the slim reference index is cached 1 h.

import { join } from "path";
import { apiFetch, BELZ_CONFIG_DIR, Cache, CliError, lifecycle } from "@belzabar/core";
import { parsePage } from "@belzabar/pd/lib/parser/index";
import { pdApi } from "@belzabar/pd/lib/api/index";
import type { RawPageResponse } from "@belzabar/pd/lib/types/wire";
import { fetchRawMethod } from "./api/v2";
import { adApi } from "./api/index";
import { normalizeUuid } from "./ids";
import type { MethodFinderIndex, MethodFinderMethod } from "./method-finder";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const lower = (v: unknown): string | undefined => str(v)?.toLowerCase();

// ── Target ──────────────────────────────────────────────────────────────────

export interface CallTarget {
  uuid: string;
  name: string;
  category: string;
  state: string;
  referenceId?: string;
  /** Automation-API uuids a V2 / V1 step may reference (lower-case, trimmed). */
  apiUuids: string[];
  /** Env-local numeric automation-API ids (V1 listing steps). */
  apiIds: number[];
  /** Chain uuids PD executes (`/chain/execute/<uuid>`). */
  chainUuids: string[];
}

/** Build the identity from the target's V2 body (+ counterpart + child-info, best effort). */
export async function resolveCallTarget(uuid: string): Promise<CallTarget> {
  const raw = (await fetchRawMethod(uuid)) as unknown as Obj;
  const meta = isObj(raw.metadata) ? raw.metadata : {};
  const service = isObj(meta.service) ? meta.service : {};
  const name = str(raw.name) ?? uuid;
  const category = str(service.name) ?? "";
  const referenceId = normalizeUuid(meta.referenceId)?.toLowerCase() ?? undefined;
  const apiUuids = new Set<string>();
  const apiIds = new Set<number>();
  const chainUuids = new Set<string>([uuid]);
  const own = lower(raw.automationApiId);
  if (own) apiUuids.add(own);
  if (referenceId) {
    chainUuids.add(referenceId);
    try {
      const other = (await fetchRawMethod(referenceId)) as unknown as Obj;
      const api = lower(other.automationApiId);
      if (api) apiUuids.add(api);
    } catch {
      /* counterpart unreadable: keep what we have */
    }
  }
  if (category) {
    try {
      const info = await adApi.fetchChildMethodInfo(category, name);
      if (isObj(info)) {
        const api = lower(info.uuid);
        if (api) apiUuids.add(api);
        if (typeof info.id === "number") apiIds.add(info.id);
        const chain = lower(info.methodUUID ?? info.serviceChainUID);
        if (chain) chainUuids.add(chain);
      }
    } catch {
      /* draft-only methods have no published API: uuid refs still match */
    }
  }
  return {
    uuid,
    name,
    category,
    state: str(meta.state) ?? "UNKNOWN",
    referenceId,
    apiUuids: [...apiUuids],
    apiIds: [...apiIds],
    chainUuids: [...chainUuids],
  };
}

// ── AD side ─────────────────────────────────────────────────────────────────

/** One step of a V2 body, reduced to what caller matching / reporting needs. */
export interface StepRef {
  i: number;
  api?: string;
  service?: string;
  method?: string;
  description?: string;
  inputs?: string[];
  outputs?: string[];
}

const TTL_REFS = 30 * 24 * 60 * 60 * 1000; // keyed by uuid@updatedOn: an edit changes the key
const refsCache = new Cache<StepRef[]>({ dir: join(BELZ_CONFIG_DIR, "cache", "callers"), ttlMs: TTL_REFS });
/** A body the server refuses (e.g. 400 on a broken V2 conversion) is not retried for a day. */
const refsErrorCache = new Cache<string>({ dir: join(BELZ_CONFIG_DIR, "cache", "callers-errors"), ttlMs: 24 * 60 * 60 * 1000 });

function inputKeys(inputs: unknown, prefix = ""): string[] {
  const out: string[] = [];
  for (const i of Array.isArray(inputs) ? inputs : []) {
    if (!isObj(i)) continue;
    const key = str(i.key);
    if (!key) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = Array.isArray(i.properties) ? i.properties.filter((p) => isObj(p) && "key" in p) : [];
    if (nested.length) out.push(...inputKeys(nested, path));
    else if (typeof i.value === "string" ? i.value !== "" : i.value !== undefined && i.value !== null) out.push(path);
  }
  return out;
}

export function stepRefsOf(body: unknown): StepRef[] {
  const b = isObj(body) ? body : {};
  return (Array.isArray(b.steps) ? b.steps : []).filter(isObj).map((s, idx): StepRef => {
    const ref: StepRef = { i: idx + 1 };
    const api = lower(s.automationAPIId);
    if (api) ref.api = api;
    if (str(s.serviceName)) ref.service = str(s.serviceName);
    if (str(s.methodName)) ref.method = str(s.methodName);
    if (str(s.description)) ref.description = str(s.description);
    const ins = inputKeys(s.inputs);
    if (ins.length) ref.inputs = ins;
    const outs = (Array.isArray(s.outputs) ? s.outputs : []).filter(isObj).map((o) => str(o.fieldCode) ?? str(o.key)).filter((x): x is string => !!x);
    if (outs.length) ref.outputs = outs;
    return ref;
  });
}

/**
 * Refs-cache key: the index's `updatedOn`, or — for a method belz changed
 * after the index was built (ADR-R1) — the mark time, so the edit is re-read.
 */
function refsKey(m: MethodFinderMethod, dirty?: Map<string, number>): string {
  const mark = dirty?.get(m.uuid.toLowerCase());
  return mark !== undefined ? `${m.uuid}@dirty-${mark}` : `${m.uuid}@${m.updatedOn || 0}`;
}

async function stepRefsFor(m: MethodFinderMethod, key: string): Promise<StepRef[]> {
  const cached = await refsCache.load(key);
  if (cached) return cached;
  const failed = await refsErrorCache.load(key);
  if (failed) throw new Error(`${failed} (cached failure; --refresh retries)`);
  let body: unknown;
  try {
    body = await fetchRawMethod(m.uuid);
  } catch (e) {
    await refsErrorCache.save(key, e instanceof Error ? e.message : String(e));
    throw e;
  }
  const refs = stepRefsOf(body);
  await refsCache.save(key, refs);
  return refs;
}

export function stepCallsTarget(step: StepRef, t: CallTarget): boolean {
  if (step.api && t.apiUuids.includes(step.api)) return true;
  return !!step.service && !!step.method && step.service === t.category && step.method === t.name;
}

function indexCallsTarget(m: MethodFinderMethod, t: CallTarget): boolean {
  for (const c of m.calls ?? []) {
    if (c.startsWith("u:") && t.apiUuids.includes(c.slice(2))) return true;
    if (c.startsWith("n:") && t.apiIds.includes(Number(c.slice(2)))) return true;
  }
  return false;
}

export interface AdCaller {
  name: string;
  category: string;
  state: string;
  uuid: string;
  referenceId?: string;
  /** `N "description" in: k1,k2 -> out1` per calling step. */
  steps: string[];
}

export interface CallersScope {
  /** Lower-case category names whose opaque steps are resolved via V2 reads; null = all. */
  deep: Set<string> | null;
  /**
   * Methods belz wrote after the index was built (`loadDirtyMethods`): their
   * index entry may be stale, so they are always re-read; marked uuids the
   * index lacks (created since) are read too; deleted ones drop out.
   */
  dirty?: Map<string, number>;
}

export interface AdCallersResult {
  callers: AdCaller[];
  coverage: {
    indexedMethods: number;
    deepCategories: string[] | "all";
    /** Methods whose opaque steps were read (V2, cached). */
    resolvedMethods: number;
    /** Methods outside the deep scope with opaque steps: callers may hide there. */
    unscannedMethods: number;
    unscannedCategories?: string[];
    /** Methods belz changed since the index was built, re-read from their bodies. */
    rereadMethods?: number;
    /** V2 reads that failed (method skipped). */
    errors?: string[];
  };
}

function isNotFound(e: unknown): boolean {
  return e instanceof CliError && e.code === "METHOD_NOT_FOUND";
}

/** An index-shaped record for a method the index does not list yet (from its V2 body). */
function stubFromBody(uuid: string, body: unknown): MethodFinderMethod {
  const b = isObj(body) ? body : {};
  const meta = isObj(b.metadata) ? b.metadata : {};
  const service = isObj(meta.service) ? meta.service : {};
  return {
    uuid,
    referenceId: normalizeUuid(meta.referenceId)?.toLowerCase() ?? "",
    aliasName: str(b.aliasName) ?? "",
    methodName: str(b.name) ?? uuid,
    state: (str(meta.state) ?? "UNKNOWN").toUpperCase(),
    version: 0,
    categoryUuid: "",
    categoryName: str(service.name) ?? "",
    createdOn: 0,
    updatedOn: 0,
    url: "",
  };
}

function stepLine(s: StepRef): string {
  let line = String(s.i);
  if (s.description) line += ` "${s.description.length > 60 ? `${s.description.slice(0, 60)}…` : s.description}"`;
  if (s.inputs?.length) line += ` in: ${s.inputs.join(",")}`;
  if (s.outputs?.length) line += ` -> ${s.outputs.join(",")}`;
  return line;
}

const CONCURRENCY = 6;

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await worker(items[i]!);
    }),
  );
}

export async function findAdCallers(
  index: MethodFinderIndex,
  target: CallTarget,
  scope: CallersScope,
  opts: { retryFailed?: boolean } = {},
): Promise<AdCallersResult> {
  const self = new Set([target.uuid, ...(target.referenceId ? [target.referenceId] : [])]);
  const candidates = new Set<MethodFinderMethod>();
  const toRead: MethodFinderMethod[] = [];
  const unscanned = new Map<string, number>();
  const dirty = scope.dirty ?? new Map<string, number>();
  const listed = new Set<string>();
  for (const m of index.methods) {
    const id = m.uuid.toLowerCase();
    listed.add(id);
    if (self.has(id)) continue;
    // Changed by belz since the listing: the indexed calls may be wrong either way.
    if (dirty.has(id)) toRead.push(m);
    else if (indexCallsTarget(m, target)) candidates.add(m);
    else if ((m.opaqueSteps ?? 0) > 0) {
      if (!scope.deep || scope.deep.has(m.categoryName.toLowerCase())) toRead.push(m);
      else unscanned.set(m.categoryName, (unscanned.get(m.categoryName) ?? 0) + 1);
    }
  }

  const errors: string[] = [];
  const refsByUuid = new Map<string, StepRef[]>();
  const deleted = new Set<string>();

  // Created by belz since the listing: not in the index at all.
  const unlisted = [...dirty.keys()].filter((id) => !listed.has(id) && !self.has(id));
  await pool(unlisted, async (id) => {
    try {
      const body = await fetchRawMethod(id);
      const m = stubFromBody(id, body);
      if (m.referenceId && self.has(m.referenceId)) return;
      refsByUuid.set(m.uuid, stepRefsOf(body));
      toRead.push(m);
    } catch (e) {
      if (!isNotFound(e)) errors.push(`(new) ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  let done = 0;
  const work = [...toRead.filter((m) => !refsByUuid.has(m.uuid)), ...[...candidates].filter((m) => !toRead.includes(m))];
  await pool(work, async (m) => {
    const key = refsKey(m, dirty);
    try {
      if (opts.retryFailed) await refsErrorCache.invalidate(key);
      refsByUuid.set(m.uuid, await stepRefsFor(m, key));
    } catch (e) {
      if (dirty.has(m.uuid.toLowerCase()) && isNotFound(e)) deleted.add(m.uuid); // deleted by belz
      else errors.push(`${m.categoryName}/${m.methodName} (${m.uuid}): ${e instanceof Error ? e.message : String(e)}`);
    }
    done++;
    if (work.length > 20 && (done % 50 === 0 || done === work.length)) lifecycle.notice(`Reading method bodies: ${done}/${work.length}`);
  });

  const callers: AdCaller[] = [];
  for (const m of [...candidates, ...toRead]) {
    if (deleted.has(m.uuid)) continue;
    const refs = refsByUuid.get(m.uuid);
    const steps = (refs ?? []).filter((s) => stepCallsTarget(s, target));
    if (steps.length === 0 && !(candidates.has(m) && !refs)) continue;
    callers.push({
      name: m.methodName,
      category: m.categoryName,
      state: m.state,
      uuid: m.uuid,
      ...(m.referenceId ? { referenceId: m.referenceId } : {}),
      steps: steps.length ? steps.map(stepLine) : ["(matched by the index; body unreadable)"],
    });
  }
  callers.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.state.localeCompare(b.state));

  const unscannedMethods = [...unscanned.values()].reduce((a, b) => a + b, 0);
  return {
    callers,
    coverage: {
      indexedMethods: index.methods.length,
      deepCategories: scope.deep ? [...scope.deep] : "all",
      resolvedMethods: refsByUuid.size,
      unscannedMethods,
      ...(unscannedMethods ? { unscannedCategories: [...unscanned.keys()].sort() } : {}),
      ...(dirty.size ? { rereadMethods: toRead.filter((m) => dirty.has(m.uuid.toLowerCase())).length } : {}),
      ...(errors.length ? { errors } : {}),
    },
  };
}

// ── PD side ─────────────────────────────────────────────────────────────────

export interface PdRefItem {
  type: "PAGE" | "COMPONENT";
  id: string;
  name: string;
  status: string;
  calls: Array<{ adId: string; label: string; callId?: string; triggers?: string[] }>;
}

const pdRefsCache = new Cache<PdRefItem[]>({ dir: join(BELZ_CONFIG_DIR, "cache", "pd-ad-refs"), ttlMs: 60 * 60 * 1000 });

export function pdRefsOf(item: RawPageResponse, type: PdRefItem["type"]): PdRefItem | null {
  if (typeof item.configuration !== "string" || !item.configuration.includes("/chain/execute/")) return null;
  const page = parsePage(item);
  const calls = page.httpRequests
    .filter((c) => c.adId)
    .map((c) => ({
      adId: c.adId!.toLowerCase(),
      label: c.label.trim(),
      ...(c.callId ? { callId: c.callId } : {}),
      ...(c.triggers.length ? { triggers: c.triggers } : {}),
    }));
  if (calls.length === 0) return null;
  return { type, id: String(item.id), name: String(item.name ?? ""), status: String(item.status ?? "DRAFT"), calls };
}

/** PAGE drafts with configuration (the plain page list omits it; apiInfoLevel=MEDIUM includes it). */
async function fetchPagesWithConfig(): Promise<RawPageResponse[]> {
  const res = await apiFetch("/rest/api/pagedesigner/pages?status=DRAFT&pageType=PAGE&apiInfoLevel=MEDIUM", {
    method: "GET",
    authMode: "Bearer",
    timeoutMs: 180_000,
  });
  if (!res.ok) throw new Error(`GET /pagedesigner/pages (PAGE, MEDIUM) → ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as RawPageResponse[]) : [];
}

export async function loadPdRefs(refresh: boolean): Promise<{ items: PdRefItem[]; source: "cache" | "fresh" }> {
  if (!refresh) {
    const cached = await pdRefsCache.load("index");
    if (cached) return { items: cached, source: "cache" };
  }
  lifecycle.notice("Listing PD pages and components (with configuration)…");
  const [pages, components] = await Promise.all([fetchPagesWithConfig(), pdApi.fetchAllComponents()]);
  const items: PdRefItem[] = [];
  for (const p of pages) {
    const r = pdRefsOf(p, "PAGE");
    if (r) items.push(r);
  }
  for (const c of components as RawPageResponse[]) {
    const r = pdRefsOf(c, "COMPONENT");
    if (r) items.push(r);
  }
  await pdRefsCache.save("index", items);
  return { items, source: "fresh" };
}

export interface PdCaller {
  type: "PAGE" | "COMPONENT";
  name: string;
  id: string;
  status: string;
  /** `label (callId) on trigger,…` per httpRequest executing the target. */
  calls: string[];
}

export function findPdCallers(items: PdRefItem[], target: CallTarget): PdCaller[] {
  const out: PdCaller[] = [];
  for (const it of items) {
    const hits = it.calls.filter((c) => target.chainUuids.includes(c.adId));
    if (!hits.length) continue;
    out.push({
      type: it.type,
      name: it.name,
      id: it.id,
      status: it.status,
      calls: hits.map((c) => `${c.label || "(unnamed)"}${c.callId ? ` (${c.callId})` : ""}${c.triggers?.length ? ` on ${c.triggers.join(",")}` : ""}`),
    });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}
