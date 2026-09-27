import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { vlog } from "./verbose";
import { Config } from "./config";

type TtlSpec = number | null | ((key: string) => number | null);

export interface CacheOptions<T> {
  dir: string;
  /** Hard TTL — past this an entry is expired and discarded. */
  ttlMs: TtlSpec;
  /** Soft TTL — past this an entry is stale-but-usable (stale-while-revalidate). */
  staleMs?: TtlSpec;
  /**
   * Namespace entries by environment: files live at `<dir>/<env>/<key>.json`.
   * Default `true` — ids (method uuids, page ids, automation ids) collide
   * across envs, so an unscoped cache serves env A's data as env B. Opt out
   * only when the key itself already encodes the env (or data is env-agnostic).
   */
  envScoped?: boolean;
}

/** Normalize a cache key to a safe file stem: stringified, trimmed, no path separators. */
export function normalizeCacheKey(key: string | number): string {
  return String(key).trim().replace(/[\/\\\0]/g, "_");
}

/** The env name used to scope cache entries when none is passed explicitly. */
export function currentCacheEnv(): string {
  try {
    return Config.activeEnv?.name || "default";
  } catch {
    return "default";
  }
}

interface CacheEntry<T> {
  savedAt: number;
  data: T;
}

/** Stale-while-revalidate load result. `stale` means the data is past the soft TTL. */
export interface CacheResult<T> {
  data: T;
  stale: boolean;
  savedAt: number;
}

export class Cache<T> {
  constructor(private options: CacheOptions<T>) {}

  /**
   * Directory backing this cache for the active env (useful for sidecar files
   * like refresh locks). Resolved on every access so it follows `--env`.
   */
  get dir(): string {
    return this.dirFor();
  }

  /** Directory backing this cache for `env` (default: the active env). */
  dirFor(env?: string): string {
    if (this.options.envScoped === false) return this.options.dir;
    return join(this.options.dir, normalizeCacheKey(env ?? currentCacheEnv()));
  }

  private resolveSpec(spec: TtlSpec, key: string): number | null {
    if (typeof spec === "function") return spec(key);
    return spec;
  }

  private filePath(key: string, env?: string): string {
    return join(this.dirFor(env), `${key}.json`);
  }

  async save(rawKey: string | number, data: T, env?: string): Promise<void> {
    const key = normalizeCacheKey(rawKey);
    await mkdir(this.dirFor(env), { recursive: true });
    const entry: CacheEntry<T> = { savedAt: Date.now(), data };
    await Bun.write(this.filePath(key, env), JSON.stringify(entry, null, 2));
    vlog(`CACHE WRITE ${key}`);
  }

  /** Drop an entry (e.g. after a write made it stale). Never throws. */
  async invalidate(rawKey: string | number, env?: string): Promise<void> {
    const key = normalizeCacheKey(rawKey);
    try {
      await rm(this.filePath(key, env), { force: true });
      vlog(`CACHE INVALIDATE ${key}`);
    } catch (e) {
      vlog(`CACHE INVALIDATE ERROR ${key}`, { error: String(e) });
    }
  }

  async load(rawKey: string | number, env?: string): Promise<T | null> {
    const key = normalizeCacheKey(rawKey);
    const file = Bun.file(this.filePath(key, env));
    if (!(await file.exists())) {
      vlog(`CACHE MISS ${key}`);
      return null;
    }
    try {
      const entry = (await file.json()) as CacheEntry<T>;
      const ttl = this.resolveSpec(this.options.ttlMs, key);
      if (ttl !== null && Date.now() - entry.savedAt > ttl) {
        vlog(`CACHE EXPIRED ${key}`);
        return null;
      }
      vlog(`CACHE HIT ${key}`);
      return entry.data;
    } catch (e) {
      vlog(`CACHE ERROR ${key}`, { error: String(e) });
      return null;
    }
  }

  /**
   * Stale-while-revalidate load. Returns the entry whenever it is within the hard
   * TTL, flagging `stale: true` once it is past the soft TTL. Returns null on miss,
   * hard expiry, or read error. When no `staleMs` is configured this behaves like
   * `load()` (entries are never reported stale).
   */
  async loadSwr(rawKey: string | number, env?: string): Promise<CacheResult<T> | null> {
    const key = normalizeCacheKey(rawKey);
    const file = Bun.file(this.filePath(key, env));
    if (!(await file.exists())) {
      vlog(`CACHE MISS ${key}`);
      return null;
    }
    try {
      const entry = (await file.json()) as CacheEntry<T>;
      const age = Date.now() - entry.savedAt;
      const ttl = this.resolveSpec(this.options.ttlMs, key);
      if (ttl !== null && age > ttl) {
        vlog(`CACHE EXPIRED ${key}`);
        return null;
      }
      const staleTtl =
        this.options.staleMs === undefined
          ? null
          : this.resolveSpec(this.options.staleMs, key);
      const stale = staleTtl !== null && age > staleTtl;
      vlog(`${stale ? "CACHE STALE" : "CACHE HIT"} ${key}`);
      return { data: entry.data, stale, savedAt: entry.savedAt };
    } catch (e) {
      vlog(`CACHE ERROR ${key}`, { error: String(e) });
      return null;
    }
  }
}
