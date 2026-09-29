import { join } from "path";
import { apiFetch, asObj, BELZ_CONFIG_DIR, Cache, CliError, Config, containsWordStart, dedupeBy, levenshtein, normalizeSearchText, numLike, readJsonOrNull, scoreText, strOrNull, tokenize } from "@belzabar/core";

const CATEGORY_PAGE_LIMIT = 2000;
const METHOD_PAGE_LIMIT = 100;
export const METHOD_FINDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * An index with skipped categories (a listing failed mid-build, e.g. a 503) is
 * only reused this long, then rebuilt (ADR-R2).
 */
export const PARTIAL_INDEX_TTL_MS = 15 * 60 * 1000;
/**
 * Bumped when index records gain fields. 2 (Stage 7): `summary`, `description`,
 * `automationApiUuid`, `calls`, `opaqueSteps` — used by `find --describe` and
 * `ad callers`, which rebuild an older cached index (plain `find` keeps using it).
 */
export const METHOD_FINDER_SCHEMA = 2;
/** Per-method text kept in the index (summary / description), to bound its size. */
const TEXT_CAP = 400;

const methodFinderCache = new Cache<MethodFinderIndex>({
  dir: join(BELZ_CONFIG_DIR, "cache", "method-finder"),
  ttlMs: METHOD_FINDER_CACHE_TTL_MS,
  envScoped: false, // key already encodes the env (index-v1-<env>)
});

const indexKey = (env: string) => `index-v1-${env}`;

/**
 * Methods belz itself wrote since the index was built (ADR-R1): uuid → when
 * it was marked. Kept beside the index (not in it) so a mark never rewrites
 * the multi-MB index nor resets its age.
 */
const dirtyCache = new Cache<Record<string, number>>({
  dir: join(BELZ_CONFIG_DIR, "cache", "method-finder"),
  ttlMs: METHOD_FINDER_CACHE_TTL_MS,
  envScoped: false,
});
const dirtyKey = (env: string) => `dirty-${env}`;

/**
 * Mark a method's index entry stale after belz changed it (save, create,
 * publish, delete, restore). `ad callers` re-reads marked methods' bodies
 * whatever the scope, and reads marked uuids the index does not list yet
 * (new methods). Never throws.
 */
export async function invalidateMethodIndexEntry(env: string, uuid: string | null | undefined): Promise<void> {
  const id = uuid?.trim().toLowerCase();
  if (!id) return;
  try {
    const now = Date.now();
    const marks = (await dirtyCache.load(dirtyKey(env))) ?? {};
    for (const [k, at] of Object.entries(marks)) if (now - at > METHOD_FINDER_CACHE_TTL_MS) delete marks[k];
    marks[id] = now;
    await dirtyCache.save(dirtyKey(env), marks);
  } catch {
    /* best effort: a missed mark only means a stale index entry */
  }
}

const goneKey = (env: string) => `gone-${env}`;

/**
 * Record that a method no longer exists (belz deleted it, or a V2 read answered
 * METHOD_NOT_FOUND — soft-deleted methods do). `find` and `callers` drop gone
 * uuids from a cached index, so a deletion shows without `--refresh` (CLI
 * trial). A fresh index build clears the marks. Never throws.
 */
export async function markMethodGone(env: string, uuid: string | null | undefined): Promise<void> {
  const id = uuid?.trim().toLowerCase();
  if (!id) return;
  try {
    const marks = (await dirtyCache.load(goneKey(env))) ?? {};
    marks[id] = Date.now();
    await dirtyCache.save(goneKey(env), marks);
  } catch {
    /* best effort */
  }
}

/** A V2 read of the uuid succeeded: drop a stale gone mark. Never throws. */
export async function unmarkMethodGone(env: string, uuid: string | null | undefined): Promise<void> {
  const id = uuid?.trim().toLowerCase();
  if (!id) return;
  try {
    const marks = await dirtyCache.load(goneKey(env));
    if (!marks || !(id in marks)) return;
    delete marks[id];
    await dirtyCache.save(goneKey(env), marks);
  } catch {
    /* best effort */
  }
}

/** True when the uuid carries a gone mark on this env (see markMethodGone). */
export async function isMethodGone(env: string, uuid: string): Promise<boolean> {
  const marks = (await dirtyCache.load(goneKey(env)).catch(() => null)) ?? {};
  return uuid.trim().toLowerCase() in marks;
}

async function withoutGone(index: MethodFinderIndex): Promise<MethodFinderIndex> {
  const marks = (await dirtyCache.load(goneKey(index.env)).catch(() => null)) ?? {};
  if (Object.keys(marks).length === 0) return index;
  const gone = (m: MethodFinderMethod) => m.uuid.toLowerCase() in marks;
  const methods = index.methods.filter((m) => !gone(m));
  if (methods.length === index.methods.length) return index;
  const removed = new Map<string, number>();
  for (const m of index.methods) if (gone(m)) removed.set(m.categoryUuid, (removed.get(m.categoryUuid) ?? 0) + 1);
  return {
    ...index,
    methods,
    methodCount: methods.length,
    categories: index.categories.map((c) => (removed.has(c.uuid) ? { ...c, methodCount: Math.max(0, c.methodCount - removed.get(c.uuid)!) } : c)),
  };
}

/**
 * Add a method belz just created to the cached index (if there is one), so
 * `find` lists it without a rebuild (CLI trial). Never throws.
 */
export async function addMethodToIndex(
  env: string,
  m: { uuid: string; name: string; categoryUuid: string; categoryName: string; summary?: string },
): Promise<void> {
  try {
    const key = indexKey(env);
    const index = await methodFinderCache.load(key);
    const uuid = m.uuid.trim().toLowerCase();
    if (!index || index.methods.some((x) => x.uuid.toLowerCase() === uuid)) return;
    const now = Date.now();
    index.methods.push({
      uuid,
      referenceId: "",
      aliasName: m.name,
      methodName: m.name,
      state: "DRAFT",
      version: 1,
      categoryUuid: m.categoryUuid,
      categoryName: m.categoryName,
      createdOn: now,
      updatedOn: now,
      url: buildMethodUrl(m.categoryName, uuid),
      ...(m.summary ? { summary: m.summary } : {}),
    });
    index.methodCount = index.methods.length;
    const cat = index.categories.find((c) => c.uuid === m.categoryUuid);
    if (cat) cat.methodCount += 1;
    await methodFinderCache.save(key, index);
  } catch {
    /* best effort: a rebuild lists it anyway */
  }
}

/** Drop the env's whole index (a write whose method uuids are unknown, e.g. `ad import`). Never throws. */
export async function dropMethodIndex(env: string): Promise<void> {
  await methodFinderCache.invalidate(indexKey(env));
}

/** Uuids belz marked after `index` was listed (lower-case uuid → mark time). */
export async function loadDirtyMethods(index: MethodFinderIndex): Promise<Map<string, number>> {
  const since = index.buildStartedAt ?? index.generatedAt;
  const marks = (await dirtyCache.load(dirtyKey(index.env))) ?? {};
  return new Map(Object.entries(marks).filter(([, at]) => at >= since));
}

export interface MethodFinderCategory {
  /** Chain-category uuid (trimmed) — the same identity as `ad categories` (AD-10). */
  uuid: string;
  /** Chain-category id (methods' category.id; what export-category takes). Absent in pre-4A index caches. */
  chainCategoryId?: number | null;
  /** Automation-system uuid (trimmed). */
  systemUuid?: string | null;
  name: string;
  label: string;
  aliasNames: string[];
  methodCount: number;
}

export interface MethodFinderMethod {
  uuid: string;
  referenceId: string;
  aliasName: string;
  methodName: string;
  state: string;
  version: number;
  categoryUuid: string;
  categoryName: string;
  createdOn: number;
  updatedOn: number;
  url: string;
  /** Schema 2: the method's own automation-API uuid (what callers' steps reference). */
  automationApiUuid?: string;
  /** Schema 2: summary / description text (capped). */
  summary?: string;
  description?: string;
  /**
   * Schema 2: callee refs of the method's steps, from the listing's V1
   * jsonDefinition: `u:<apiUuid>` (step carries automationApiUuid) or
   * `n:<numericApiId>` (env-local numeric automationApiId). Custom-code steps
   * have none.
   */
  calls?: string[];
  /** Schema 2: steps identified only by their numeric automationId (callee unknown without a V2 read). */
  opaqueSteps?: number;
}

export interface MethodFinderIndex {
  /** Absent = schema 1. */
  schemaVersion?: number;
  env: string;
  /** When the listing started; belz writes marked after it are re-read (absent in older caches). */
  buildStartedAt?: number;
  generatedAt: number;
  /** True when some category listings failed (`skippedCategories`): methods are missing (ADR-R2). */
  partial?: boolean;
  categories: MethodFinderCategory[];
  methods: MethodFinderMethod[];
  skippedCategories: Array<{
    categoryUuid: string;
    categoryName: string;
    status: number | null;
    reason: string;
  }>;
  categoryCount: number;
  methodCount: number;
}

export interface MethodFinderMethodMatch extends MethodFinderMethod {
  type: "method";
  score: number;
}

export interface MethodFinderCategoryMatch extends MethodFinderCategory {
  type: "category";
  score: number;
}

export type MethodFinderMatch = MethodFinderMethodMatch | MethodFinderCategoryMatch;

interface MethodFinderCacheResult {
  index: MethodFinderIndex;
  source: "cache" | "fresh";
}

interface RawServiceCategory {
  id: number | null;
  systemUuid: string | null;
  uuid: string;
  name: string;
  label: string;
  aliasName: string[];
}

interface RawMethodRecord {
  uuid: string;
  referenceId: string;
  aliasName: string;
  name: string;
  automationState: string;
  state: string;
  version: number;
  jsonDefinition: string;
  createdOn: number;
  lastUpdatedOn: number;
  updatedOn: number;
}

export interface IndexProgress {
  done: number;
  total: number;
  category: string;
}

export async function loadOrBuildMethodFinderIndex(options: {
  refresh: boolean;
  /** Called after each category is indexed (F29: a refresh takes minutes). */
  onProgress?: (p: IndexProgress) => void;
  /** Rebuild a cached index older than this schema (describe / callers need 2). */
  minSchema?: number;
  /** Rebuild a cached index generated longer ago than this (default: the 7-day TTL). */
  maxAgeMs?: number;
}): Promise<MethodFinderCacheResult> {
  const cacheKey = indexKey(Config.activeEnv.name);

  if (!options.refresh) {
    const cached = await methodFinderCache.load(cacheKey);
    const age = cached ? Date.now() - cached.generatedAt : 0;
    const partial = !!cached && (!!cached.partial || (cached.skippedCategories?.length ?? 0) > 0);
    if (
      cached &&
      cached.env === Config.activeEnv.name &&
      (cached.schemaVersion ?? 1) >= (options.minSchema ?? 1) &&
      age <= (options.maxAgeMs ?? METHOD_FINDER_CACHE_TTL_MS) &&
      !(partial && age > PARTIAL_INDEX_TTL_MS)
    ) {
      return { index: await withoutGone(cached), source: "cache" };
    }
  }

  const index = await buildMethodFinderIndex(options.onProgress);
  await methodFinderCache.save(cacheKey, index);
  await dirtyCache.invalidate(goneKey(index.env));
  return { index, source: "fresh" };
}

export function listMethodFinderCategories(index: MethodFinderIndex): MethodFinderCategory[] {
  return [...index.categories].sort((a, b) => a.name.localeCompare(b.name));
}

export function searchMethodIndex(index: MethodFinderIndex, query: string, limit: number): MethodFinderMatch[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const matches: MethodFinderMatch[] = [];

  for (const method of index.methods) {
    const score = scoreMethodMatch(normalizedQuery, method);
    if (score > 0) {
      matches.push({
        type: "method",
        score,
        ...method,
      });
    }
  }

  for (const category of index.categories) {
    const score = scoreCategoryMatch(normalizedQuery, category);
    if (score > 0) {
      matches.push({
        type: "category",
        score,
        ...category,
      });
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.type !== b.type) return a.type === "method" ? -1 : 1;
    const aName = a.type === "method" ? a.methodName : a.name;
    const bName = b.type === "method" ? b.methodName : b.name;
    return aName.localeCompare(bName);
  });

  return matches.slice(0, Math.max(1, limit));
}

export function normalizeCategoryRecord(input: unknown): RawServiceCategory | null {
  const record = unwrapWrappedRecord(input);
  if (!record) return null;

  const uuid = strOrNull(record.uuid);
  const name = strOrNull(record.name) ?? strOrNull(record.label);
  if (!uuid || !name) return null;

  return {
    id: numLike(record.id),
    systemUuid: strOrNull(record.automationSystemUuid),
    uuid,
    name,
    label: strOrNull(record.label) ?? name,
    aliasName: getStringArray(record.aliasName),
  };
}

export function normalizeMethodRecord(
  input: unknown,
  category: { uuid: string; name: string }
): MethodFinderMethod | null {
  const record = unwrapWrappedRecord(input);
  if (!record) return null;

  const raw = asRawMethodRecord(record);
  const uuid = raw.uuid;
  if (!uuid) return null;

  const fallbackName = raw.aliasName || raw.name || raw.referenceId || uuid;
  const state = (raw.automationState || raw.state || "UNKNOWN").toUpperCase();
  // AD URLs need the DRAFT uuid so the path opens an editable method; a
  // published row's `referenceId` points at the linked draft, if any.
  const draftUuid = state === "PUBLISHED" && raw.referenceId ? raw.referenceId : uuid;

  const def = parseDefinition(raw.jsonDefinition);
  const method: MethodFinderMethod = {
    uuid,
    referenceId: raw.referenceId,
    aliasName: raw.aliasName,
    methodName: strOrNull(def?.name) ?? fallbackName,
    state,
    version: raw.version,
    categoryUuid: category.uuid,
    categoryName: category.name,
    createdOn: raw.createdOn,
    updatedOn: raw.lastUpdatedOn || raw.updatedOn,
    url: buildMethodUrl(category.name, draftUuid),
  };
  const apiUuid = strOrNull(record.automationApiUuid);
  if (apiUuid) method.automationApiUuid = apiUuid.toLowerCase();
  const summary = capText(strOrNull(def?.summary));
  if (summary) method.summary = summary;
  const description = capText(strOrNull(record.methodDescription) ?? strOrNull(def?.methodDescription) ?? strOrNull(def?.description));
  if (description && description !== summary) method.description = description;
  if (def) {
    const { calls, opaque } = stepCallRefs(def);
    method.calls = calls;
    if (opaque) method.opaqueSteps = opaque;
  }
  return method;
}

function capText(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_CAP ? `${flat.slice(0, TEXT_CAP)}…` : flat;
}

function parseDefinition(jsonDefinition: string): Record<string, unknown> | null {
  if (!jsonDefinition) return null;
  try {
    return asObj(JSON.parse(jsonDefinition));
  } catch {
    return null;
  }
}

/**
 * Callee refs of a V1 jsonDefinition's steps (`services[]`): `u:<apiUuid>` /
 * `n:<numericApiId>`, de-duplicated; custom-code steps skipped; steps with
 * only an `automationId` are counted as opaque.
 */
export function stepCallRefs(def: Record<string, unknown>): { calls: string[]; opaque: number } {
  const calls = new Set<string>();
  let opaque = 0;
  for (const step of getArray(def.services)) {
    const s = asObj(step);
    if (!s) continue;
    if (strOrNull(s.language) || typeof s.code === "string") continue; // custom code
    const apiUuid = strOrNull(s.automationApiUuid);
    const apiId = numLike(s.automationApiId);
    if (apiUuid) calls.add(`u:${apiUuid.toLowerCase()}`);
    else if (apiId !== null) calls.add(`n:${apiId}`);
    else if (s.automationId !== undefined && s.automationId !== null) opaque++;
  }
  return { calls: [...calls], opaque };
}

export function buildMethodUrl(categoryName: string, methodUuid: string): string {
  return `${Config.cleanBaseUrl}/automation-designer/${encodeURIComponent(categoryName)}/${methodUuid}`;
}

const CATEGORY_CONCURRENCY = 4;

async function buildMethodFinderIndex(onProgress?: (p: IndexProgress) => void): Promise<MethodFinderIndex> {
  const buildStartedAt = Date.now();
  const categories = await fetchAllCategories();
  const skippedCategories: MethodFinderIndex["skippedCategories"] = [];
  // Category order is kept (results land by index); fetches run a few at a time.
  const perCategory: MethodFinderMethod[][] = new Array(categories.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (let i = next++; i < categories.length; i = next++) {
      const category = categories[i]!;
      const result = await fetchMethodsForCategory(category);
      category.methodCount = result.methods.length;
      perCategory[i] = result.methods;
      if (result.error) {
        skippedCategories.push({
          categoryUuid: category.uuid,
          categoryName: category.name,
          status: result.status,
          reason: result.error,
        });
      }
      onProgress?.({ done: ++done, total: categories.length, category: category.name });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CATEGORY_CONCURRENCY, categories.length) }, worker));
  const methods = perCategory.flat();
  skippedCategories.sort((a, b) => a.categoryName.localeCompare(b.categoryName));

  const uniqueCategories = dedupeBy(categories, c => c.uuid);
  const uniqueMethods = dedupeBy(methods, m => m.uuid);

  return {
    schemaVersion: METHOD_FINDER_SCHEMA,
    env: Config.activeEnv.name,
    buildStartedAt,
    generatedAt: Date.now(),
    partial: skippedCategories.length > 0,
    categories: uniqueCategories,
    methods: uniqueMethods,
    skippedCategories,
    categoryCount: uniqueCategories.length,
    methodCount: uniqueMethods.length,
  };
}

async function fetchAllCategories(): Promise<MethodFinderCategory[]> {
  const categories: MethodFinderCategory[] = [];
  let offset = 0;
  const seenOffsets = new Set<number>();

  while (true) {
    if (seenOffsets.has(offset)) break;
    seenOffsets.add(offset);

    const path = `/rest/api/automation/services?limit=${CATEGORY_PAGE_LIMIT}&offset=${offset}`;
    const response = await apiFetch(path, {
      method: "GET",
      authMode: "Bearer",
    });

    if (!response.ok) {
      throw new CliError(`Failed to list AD categories for the method index: ${response.status} ${response.statusText}`.trim(), {
        code: "AD_INDEX_FETCH_FAILED",
        details: { path, status: response.status },
      });
    }

    const payload = (await readJsonOrNull<unknown>(response, { path })) ?? {};
    const result = getArray((payload as { result?: unknown }).result);

    if (result.length === 0) {
      break;
    }

    for (const entry of result) {
      const normalized = normalizeCategoryRecord(entry);
      if (!normalized) continue;

      categories.push({
        uuid: normalized.uuid,
        chainCategoryId: normalized.id,
        systemUuid: normalized.systemUuid,
        name: normalized.name,
        label: normalized.label,
        aliasNames: normalized.aliasName,
        methodCount: 0,
      });
    }

    if (result.length < CATEGORY_PAGE_LIMIT) {
      break;
    }

    const nextOffset = getNextOffset(payload, offset, CATEGORY_PAGE_LIMIT);
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  return dedupeBy(categories, c => c.uuid);
}

async function fetchMethodsForCategory(category: MethodFinderCategory): Promise<{
  methods: MethodFinderMethod[];
  status: number | null;
  error: string | null;
}> {
  const methods: MethodFinderMethod[] = [];
  let offset = 0;
  const seenOffsets = new Set<number>();

  try {
    while (true) {
      if (seenOffsets.has(offset)) break;
      seenOffsets.add(offset);

      const path = `/rest/api/automation/methods?categoryUuid=${encodeURIComponent(category.uuid)}&limit=${METHOD_PAGE_LIMIT}&offset=${offset}`;
      const response = await apiFetch(path, {
        method: "GET",
        authMode: "Bearer",
      });

      if (!response.ok) {
        return {
          methods: dedupeBy(methods, m => m.uuid),
          status: response.status,
          error: `Failed to fetch methods for category '${category.name}': ${response.status} ${response.statusText}`,
        };
      }

      const payload = (await readJsonOrNull<unknown>(response, { path })) ?? {};
      const methodList = getArray((payload as { methodList?: unknown }).methodList);

      if (methodList.length === 0) {
        break;
      }

      for (const entry of methodList) {
        const normalized = normalizeMethodRecord(entry, {
          uuid: category.uuid,
          name: category.name,
        });
        if (normalized) methods.push(normalized);
      }

      if (methodList.length < METHOD_PAGE_LIMIT) {
        break;
      }

      const nextOffset = getNextOffset(payload, offset, METHOD_PAGE_LIMIT);
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown method fetch error";
    return {
      methods: dedupeBy(methods, m => m.uuid),
      status: null,
      error: `Failed to fetch methods for category '${category.name}': ${message}`,
    };
  }

  return {
    methods: dedupeBy(methods, m => m.uuid),
    status: null,
    error: null,
  };
}

function scoreMethodMatch(query: string, method: MethodFinderMethod): number {
  const scores = [
    scoreText(query, method.methodName, 1.0),
    scoreText(query, method.aliasName, 0.95),
    scoreText(query, method.categoryName, 0.85),
    scoreText(query, method.referenceId, 0.8),
    scoreText(query, method.uuid, 0.75),
  ];

  return Math.max(...scores, 0);
}

function scoreCategoryMatch(query: string, category: MethodFinderCategory): number {
  const aliasScore = category.aliasNames.reduce((best, alias) => {
    return Math.max(best, scoreText(query, alias, 0.92));
  }, 0);

  const nameScore = scoreText(query, category.name, 1.0);
  const labelScore = scoreText(query, category.label, 0.95);
  const uuidScore = scoreText(query, category.uuid, 0.7);

  return Math.max(aliasScore, nameScore, labelScore, uuidScore);
}

function getNextOffset(payload: unknown, current: number, increment: number): number {
  const p = asObj(payload);
  const currentOffset = p ? numLike(p.currentOffset) : null;
  if (currentOffset !== null && currentOffset > current) return currentOffset;
  return current + increment;
}

function unwrapWrappedRecord(input: unknown): Record<string, unknown> | null {
  const objectValue = asObj(input);
  if (!objectValue) return null;

  if (hasKey(objectValue, "uuid") || hasKey(objectValue, "name") || hasKey(objectValue, "label")) {
    return objectValue;
  }

  const values = Object.values(objectValue);
  if (values.length === 1) {
    return asObj(values[0]);
  }

  for (const value of values) {
    const candidate = asObj(value);
    if (!candidate) continue;
    if (hasKey(candidate, "uuid") || hasKey(candidate, "name") || hasKey(candidate, "label")) {
      return candidate;
    }
  }

  return null;
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => strOrNull(item))
    .filter((item): item is string => item !== null);
}

function asRawMethodRecord(value: Record<string, unknown>): RawMethodRecord {
  return {
    uuid: strOrNull(value.uuid) ?? "",
    referenceId: strOrNull(value.referenceId) ?? "",
    aliasName: strOrNull(value.aliasName) ?? "",
    name: strOrNull(value.name) ?? "",
    automationState: strOrNull(value.automationState) ?? "",
    state: strOrNull(value.state) ?? "",
    version: numLike(value.version) ?? 0,
    jsonDefinition: strOrNull(value.jsonDefinition) ?? "",
    createdOn: numLike(value.createdOn) ?? 0,
    lastUpdatedOn: numLike(value.lastUpdatedOn) ?? 0,
    updatedOn: numLike(value.updatedOn) ?? 0,
  };
}

// ── Stage 7.5: fuzzy scoring for other catalogues, description search ──────

/** The index's name scoring (exact > prefix > word start > substring > fuzzy), for other catalogues (`ad services --search`). */
export function scoreFuzzy(query: string, value: string, weight = 1): number {
  const q = normalizeSearchText(query);
  return q ? scoreText(q, value, weight) : 0;
}

const DESCRIBE_STOPWORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "by", "with", "is", "it", "from", "that", "this", "be", "as", "at", "into"]);

export function describeTokens(text: string): string[] {
  return [...new Set(tokenize(normalizeSearchText(text)).filter((t) => t.length >= 2 && !DESCRIBE_STOPWORDS.has(t)))];
}

export interface DescribeMatch extends MethodFinderMethod {
  score: number;
  /** Query words that matched somewhere in name / alias / summary / description / category. */
  matched: string[];
}

/**
 * `ad find --describe <text>`: word search over method name, alias, summary,
 * description and category (weights 3 / 2.5 / 2 / 1.5 / 1; a word-start hit
 * counts full, a substring 0.8, a 1-edit typo on words ≥5 chars 0.5). A method
 * must match at least half of the query words; ranked by words matched, then
 * score. `category` narrows to categories whose name starts with it.
 */
export function describeSearch(index: MethodFinderIndex, text: string, limit: number, opts: { category?: string } = {}): DescribeMatch[] {
  const tokens = describeTokens(text);
  if (tokens.length === 0) return [];
  const need = Math.max(1, Math.ceil(tokens.length / 2));
  const cat = opts.category ? normalizeSearchText(opts.category) : null;
  const out: DescribeMatch[] = [];
  for (const m of index.methods) {
    if (cat && !normalizeSearchText(m.categoryName).startsWith(cat)) continue;
    const fields: Array<[string, number]> = [
      [normalizeSearchText(m.methodName), 3],
      [normalizeSearchText(m.aliasName), 2.5],
      [normalizeSearchText(m.summary ?? ""), 2],
      [normalizeSearchText(m.description ?? ""), 1.5],
      [normalizeSearchText(m.categoryName), 1],
    ];
    let score = 0;
    const matched: string[] = [];
    for (const t of tokens) {
      let best = 0;
      for (const [value, w] of fields) {
        if (!value) continue;
        let hit = 0;
        if (containsWordStart(value, t) || tokenize(value).some((v) => v.startsWith(t))) hit = 1;
        else if (value.includes(t)) hit = 0.8;
        else if (t.length >= 5 && tokenize(value).some((v) => Math.abs(v.length - t.length) <= 1 && levenshtein(t, v) <= 1)) hit = 0.5;
        best = Math.max(best, hit * w);
      }
      if (best > 0) {
        score += best;
        matched.push(t);
      }
    }
    if (matched.length >= need) out.push({ ...m, score: Math.round(score * 100) / 100, matched });
  }
  out.sort((a, b) => b.matched.length - a.matched.length || b.score - a.score || a.methodName.localeCompare(b.methodName));
  return out.slice(0, Math.max(1, limit));
}
