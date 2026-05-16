import { mkdir } from "fs/promises";
import { join } from "path";
import { vlog } from "./verbose";

type TtlSpec = number | null | ((key: string) => number | null);

export interface CacheOptions<T> {
  dir: string;
  /** Hard TTL — past this an entry is expired and discarded. */
  ttlMs: TtlSpec;
  /** Soft TTL — past this an entry is stale-but-usable (stale-while-revalidate). */
  staleMs?: TtlSpec;
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

  /** Directory backing this cache (useful for sidecar files like refresh locks). */
  get dir(): string {
    return this.options.dir;
  }

  private resolveSpec(spec: TtlSpec, key: string): number | null {
    if (typeof spec === "function") return spec(key);
    return spec;
  }

  private filePath(key: string): string {
    return join(this.options.dir, `${key}.json`);
  }

  async save(key: string, data: T): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const entry: CacheEntry<T> = { savedAt: Date.now(), data };
    await Bun.write(this.filePath(key), JSON.stringify(entry, null, 2));
    vlog(`CACHE WRITE ${key}`);
  }

  async load(key: string): Promise<T | null> {
    const file = Bun.file(this.filePath(key));
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
  async loadSwr(key: string): Promise<CacheResult<T> | null> {
    const file = Bun.file(this.filePath(key));
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
