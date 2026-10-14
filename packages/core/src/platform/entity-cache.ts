// Where the AD method and PD page caches live, and a best-effort eviction for
// callers that change entities without owning those caches (`migrate run`
// writes the TARGET env through Jenkins). The AD and PD integrations build
// their caches on these same paths, so the layout has one owner.

import { join } from "path";
import { Cache, ENTITY_CACHE_TTL_MS, FINDER_INDEX_TTL_MS } from "../cache";
import { BELZ_CONFIG_DIR } from "../config";
import { finderIndexStore } from "../finder-index";

/** Parsed AD method cache: `<dir>/<env>/<uuid>.json` (uuid lower-case). */
export const METHOD_CACHE_DIR = join(BELZ_CONFIG_DIR, "cache", "methods");
/** PD page / component config cache: `<dir>/<env>/<id>.json`. */
export const PAGE_CACHE_DIR = join(BELZ_CONFIG_DIR, "cache", "pages");
/** Finder-index name of the AD method index (`finderIndexStore`). */
export const METHOD_FINDER_INDEX = "method-finder";
/** Key of an env's "wi-impl changed these methods" marks, kept beside the method index. */
export const methodIndexDirtyKey = (env: string): string => `dirty-${env}`;

const methodIndexMarks = new Cache<Record<string, number>>({
  dir: finderIndexStore(METHOD_FINDER_INDEX).dir,
  ttlMs: FINDER_INDEX_TTL_MS,
  envScoped: false,
});

/**
 * Mark a method's index entry stale after it changed (save, create, publish,
 * delete, restore, migration). `ad callers` re-reads marked methods' bodies
 * whatever the scope, and reads marked uuids the index does not list yet
 * (new methods). Never throws.
 */
export async function markMethodIndexDirty(env: string, uuid: string | null | undefined): Promise<void> {
  const id = uuid?.trim().toLowerCase();
  if (!id) return;
  try {
    const now = Date.now();
    const marks = (await methodIndexMarks.load(methodIndexDirtyKey(env))) ?? {};
    for (const [k, at] of Object.entries(marks)) if (now - at > FINDER_INDEX_TTL_MS) delete marks[k];
    marks[id] = now;
    await methodIndexMarks.save(methodIndexDirtyKey(env), marks);
  } catch {
    /* best effort: a missed mark only means a stale index entry */
  }
}

const evictors = {
  AD: new Cache<unknown>({ dir: METHOD_CACHE_DIR, ttlMs: ENTITY_CACHE_TTL_MS }),
  PD: new Cache<unknown>({ dir: PAGE_CACHE_DIR, ttlMs: ENTITY_CACHE_TTL_MS }),
};

/**
 * Drop `env`'s cached copies of AD methods or PD pages (and mark AD methods
 * dirty in the method index). Returns the ids it processed. Never throws.
 */
export async function invalidateEntityCache(kind: "AD" | "PD", env: string, ids: readonly string[]): Promise<string[]> {
  const done: string[] = [];
  for (const raw of new Set(ids.map((id) => id.trim()).filter(Boolean))) {
    const id = kind === "AD" ? raw.toLowerCase() : raw;
    try {
      await evictors[kind].invalidate(id, env);
      if (kind === "AD") await markMethodIndexDirty(env, id);
      done.push(id);
    } catch {
      /* best effort */
    }
  }
  return done;
}
