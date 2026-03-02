import { join } from "path";
import { Cache, BELZ_CONFIG_DIR } from "@belzabar/core";
import type { HydratedMethod } from "./types";

const methodCache = new Cache<HydratedMethod>({
  dir: join(BELZ_CONFIG_DIR, "cache", "methods"),
  ttlMs: 5 * 60 * 1000,
});

export class CacheManager {
  static async save(uuid: string, data: HydratedMethod): Promise<void> {
    return methodCache.save(uuid, data);
  }

  static async load(uuid: string): Promise<HydratedMethod | null> {
    return methodCache.load(uuid);
  }
}
