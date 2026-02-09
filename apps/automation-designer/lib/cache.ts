import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import type { HydratedMethod } from "./types";

const CACHE_DIR = join(homedir(), ".belzabar-cli", "cache", "methods");
const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  fetchedAt: number;
  data: HydratedMethod;
}

export class CacheManager {
  static async ensureDir() {
    await mkdir(CACHE_DIR, { recursive: true });
  }

  static async save(uuid: string, data: HydratedMethod): Promise<void> {
    await this.ensureDir();
    const filePath = join(CACHE_DIR, `${uuid}.json`);
    const entry: CacheEntry = {
      fetchedAt: Date.now(),
      data
    };
    await Bun.write(filePath, JSON.stringify(entry, null, 2));
  }

  static async load(uuid: string): Promise<HydratedMethod | null> {
    const filePath = join(CACHE_DIR, `${uuid}.json`);
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      return null;
    }

    try {
      const entry = await file.json() as CacheEntry;
      const age = Date.now() - entry.fetchedAt;
      
      if (age > TTL_MS) {
        return null; // Stale
      }
      
      return entry.data;
    } catch (e) {
      console.warn(`Failed to read cache for ${uuid}`, e);
      return null;
    }
  }
}
