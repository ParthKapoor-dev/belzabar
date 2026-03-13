import { join } from "path";
import { BELZ_CONFIG_DIR, Cache, Config } from "@belzabar/core";
import { apiFetch } from "./api";

const CATEGORY_PAGE_LIMIT = 2000;
const METHOD_PAGE_LIMIT = 100;
export const METHOD_FINDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const methodFinderCache = new Cache<MethodFinderIndex>({
  dir: join(BELZ_CONFIG_DIR, "cache", "method-finder"),
  ttlMs: METHOD_FINDER_CACHE_TTL_MS,
});

export interface MethodFinderCategory {
  uuid: string;
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
}

export interface MethodFinderIndex {
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

export async function loadOrBuildMethodFinderIndex(options: { refresh: boolean }): Promise<MethodFinderCacheResult> {
  const cacheKey = `index-v1-${Config.activeEnv.name}`;

  if (!options.refresh) {
    const cached = await methodFinderCache.load(cacheKey);
    if (cached && cached.env === Config.activeEnv.name) {
      return { index: cached, source: "cache" };
    }
  }

  const index = await buildMethodFinderIndex();
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

  return {
    uuid,
    referenceId: raw.referenceId,
    aliasName: raw.aliasName,
    methodName: extractMethodName(raw.jsonDefinition, fallbackName),
    state: (raw.automationState || raw.state || "UNKNOWN").toUpperCase(),
    version: raw.version,
    categoryUuid: category.uuid,
    categoryName: category.name,
    createdOn: raw.createdOn,
    updatedOn: raw.lastUpdatedOn || raw.updatedOn,
    url: buildMethodUrl(category.name, uuid),
  };
}

export function buildMethodUrl(categoryName: string, methodUuid: string): string {
  return `${Config.cleanBaseUrl}/automation-designer/${encodeURIComponent(categoryName)}/${methodUuid}`;
}

async function buildMethodFinderIndex(): Promise<MethodFinderIndex> {
  const categories = await fetchAllCategories();
  const methods: MethodFinderMethod[] = [];
  const skippedCategories: MethodFinderIndex["skippedCategories"] = [];

  for (const category of categories) {
    const result = await fetchMethodsForCategory(category);
    category.methodCount = result.methods.length;
    methods.push(...result.methods);
    if (result.error) {
      skippedCategories.push({
        categoryUuid: category.uuid,
        categoryName: category.name,
        status: result.status,
        reason: result.error,
      });
    }
  }

  const uniqueCategories = dedupeBy(categories, c => c.uuid);
  const uniqueMethods = dedupeBy(methods, m => m.uuid);

  return {
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
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[rows - 1][cols - 1];
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

function extractMethodName(jsonDefinition: string, fallback: string): string {
  if (jsonDefinition) {
    try {
      const parsed = JSON.parse(jsonDefinition) as { name?: unknown };
      const name = getString(parsed.name);
      if (name) return name;
    } catch {
      // Ignore malformed definition payloads.
    }
  }
  return fallback;
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
