import { mkdir } from "fs/promises";
import { join } from "path";

export interface CacheOptions<T> {
  dir: string;
  ttlMs: number | null | ((key: string) => number | null);
}

interface CacheEntry<T> {
  savedAt: number;
  data: T;
}

export class Cache<T> {
  constructor(private options: CacheOptions<T>) {}

  private resolveTtl(key: string): number | null {
    const { ttlMs } = this.options;
    if (typeof ttlMs === "function") return ttlMs(key);
    return ttlMs;
  }

  private filePath(key: string): string {
    return join(this.options.dir, `${key}.json`);
  }

  async save(key: string, data: T): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const entry: CacheEntry<T> = { savedAt: Date.now(), data };
    await Bun.write(this.filePath(key), JSON.stringify(entry, null, 2));
  }

  async load(key: string): Promise<T | null> {
    const file = Bun.file(this.filePath(key));
    if (!(await file.exists())) return null;
    try {
      const entry = (await file.json()) as CacheEntry<T>;
      const ttl = this.resolveTtl(key);
      if (ttl !== null && Date.now() - entry.savedAt > ttl) return null;
      return entry.data;
    } catch {
      return null;
    }
  }
}
