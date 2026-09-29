import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, Config, apiFetch } from "@belzabar/core";

const CATEGORY_PAGE_LIMIT = 2000;
const METHOD_PAGE_LIMIT = 100;
export const METHOD_FINDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  generatedAt: number;
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
}): Promise<MethodFinderCacheResult> {
  const cacheKey = `index-v1-${Config.activeEnv.name}`;

  if (!options.refresh) {
    const cached = await methodFinderCache.load(cacheKey);
    if (cached && cached.env === Config.activeEnv.name && (cached.schemaVersion ?? 1) >= (options.minSchema ?? 1)) {
      return { index: cached, source: "cache" };
    }
  }

  const index = await buildMethodFinderIndex(options.onProgress);
  await methodFinderCache.save(cacheKey, index);
  return { index, source: "fresh" };
}

export function listMethodFinderCategories(index: MethodFinderIndex): MethodFinderCategory[] {
  return [...index.categories].sort((a, b) => a.name.localeCompare(b.name));
}

export function searchMethodIndex(index: MethodFinderIndex, query: string, limit: number): MethodFinderMatch[] {
  const normalizedQuery = normalize(query);
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

  const uuid = getString(record.uuid);
  const name = getString(record.name) ?? getString(record.label);
  if (!uuid || !name) return null;

  return {
    id: getNumber(record.id),
    systemUuid: getString(record.automationSystemUuid),
    uuid,
    name,
    label: getString(record.label) ?? name,
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
    methodName: getString(def?.name) ?? fallbackName,
    state,
    version: raw.version,
    categoryUuid: category.uuid,
    categoryName: category.name,
    createdOn: raw.createdOn,
    updatedOn: raw.lastUpdatedOn || raw.updatedOn,
    url: buildMethodUrl(category.name, draftUuid),
  };
  const apiUuid = getString(record.automationApiUuid);
  if (apiUuid) method.automationApiUuid = apiUuid.toLowerCase();
  const summary = capText(getString(def?.summary));
  if (summary) method.summary = summary;
  const description = capText(getString(record.methodDescription) ?? getString(def?.methodDescription) ?? getString(def?.description));
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
    return asObject(JSON.parse(jsonDefinition));
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
    const s = asObject(step);
    if (!s) continue;
    if (getString(s.language) || typeof s.code === "string") continue; // custom code
    const apiUuid = getString(s.automationApiUuid);
    const apiId = getNumber(s.automationApiId);
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
    generatedAt: Date.now(),
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
      throw new Error(`Failed to fetch categories: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
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

      const payload = await response.json();
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

function scoreText(query: string, value: string, weight: number): number {
  const normalizedValue = normalize(value);
  if (!normalizedValue) return 0;

  let base = 0;
  if (normalizedValue === query) {
    base = 1000;
  } else if (normalizedValue.startsWith(query)) {
    base = 900;
  } else if (containsWordStart(normalizedValue, query)) {
    base = 850;
  } else if (normalizedValue.includes(query)) {
    base = 760;
  } else {
    base = fuzzyScore(query, normalizedValue);
  }

  if (base <= 0) return 0;
  return Math.max(1, Math.round(base * weight));
}

function containsWordStart(value: string, query: string): boolean {
  if (value.startsWith(query)) return true;
  return value.includes(` ${query}`)
    || value.includes(`.${query}`)
    || value.includes(`_${query}`)
    || value.includes(`-${query}`)
    || value.includes(`/${query}`);
}

function fuzzyScore(query: string, value: string): number {
  const q = query.trim();
  if (!q) return 0;

  let best = 0;

  const subsequence = subsequenceScore(q, value);
  best = Math.max(best, subsequence);

  const tokens = tokenize(value);
  const maxDistance = Math.max(1, Math.floor(q.length * 0.4));

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (Math.abs(token.length - q.length) > maxDistance + 4) continue;

    const distance = levenshtein(q, token);
    if (distance > maxDistance) continue;

    const score = 640 - distance * 120 - Math.abs(token.length - q.length) * 12;
    best = Math.max(best, score);
  }

  return Math.max(0, best);
}

function subsequenceScore(query: string, value: string): number {
  let qIndex = 0;
  let vIndex = 0;

  while (qIndex < query.length && vIndex < value.length) {
    if (query[qIndex] === value[vIndex]) {
      qIndex += 1;
    }
    vIndex += 1;
  }

  if (qIndex < query.length) return 0;

  const density = query.length / Math.max(1, value.length);
  const lengthBoost = Math.min(1, query.length / 8);
  return Math.round(420 + density * 180 + lengthBoost * 40);
}

function levenshtein(a: string, b: string): number {
  // Two-row DP; indices are always in bounds, hence the `!`s.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function tokenize(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/g)
    .map(t => t.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function getNextOffset(payload: unknown, current: number, increment: number): number {
  const p = asObject(payload);
  const currentOffset = p ? getNumber(p.currentOffset) : null;
  if (currentOffset !== null && currentOffset > current) return currentOffset;
  return current + increment;
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return [...map.values()];
}

function unwrapWrappedRecord(input: unknown): Record<string, unknown> | null {
  const objectValue = asObject(input);
  if (!objectValue) return null;

  if (hasKey(objectValue, "uuid") || hasKey(objectValue, "name") || hasKey(objectValue, "label")) {
    return objectValue;
  }

  const values = Object.values(objectValue);
  if (values.length === 1) {
    return asObject(values[0]);
  }

  for (const value of values) {
    const candidate = asObject(value);
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

function getString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => getString(item))
    .filter((item): item is string => item !== null);
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asRawMethodRecord(value: Record<string, unknown>): RawMethodRecord {
  return {
    uuid: getString(value.uuid) ?? "",
    referenceId: getString(value.referenceId) ?? "",
    aliasName: getString(value.aliasName) ?? "",
    name: getString(value.name) ?? "",
    automationState: getString(value.automationState) ?? "",
    state: getString(value.state) ?? "",
    version: getNumber(value.version) ?? 0,
    jsonDefinition: getString(value.jsonDefinition) ?? "",
    createdOn: getNumber(value.createdOn) ?? 0,
    lastUpdatedOn: getNumber(value.lastUpdatedOn) ?? 0,
    updatedOn: getNumber(value.updatedOn) ?? 0,
  };
}

// ── Stage 7.5: fuzzy scoring for other catalogues, description search ──────

/** The index's name scoring (exact > prefix > word start > substring > fuzzy), for other catalogues (`ad services --search`). */
export function scoreFuzzy(query: string, value: string, weight = 1): number {
  const q = normalize(query);
  return q ? scoreText(q, value, weight) : 0;
}

const DESCRIBE_STOPWORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "by", "with", "is", "it", "from", "that", "this", "be", "as", "at", "into"]);

export function describeTokens(text: string): string[] {
  return [...new Set(tokenize(normalize(text)).filter((t) => t.length >= 2 && !DESCRIBE_STOPWORDS.has(t)))];
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
  const cat = opts.category ? normalize(opts.category) : null;
  const out: DescribeMatch[] = [];
  for (const m of index.methods) {
    if (cat && !normalize(m.categoryName).startsWith(cat)) continue;
    const fields: Array<[string, number]> = [
      [normalize(m.methodName), 3],
      [normalize(m.aliasName), 2.5],
      [normalize(m.summary ?? ""), 2],
      [normalize(m.description ?? ""), 1.5],
      [normalize(m.categoryName), 1],
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
