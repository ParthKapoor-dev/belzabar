// The fresh V2 read behind `show --compact` / `--story` and `outputs`, so the
// views agree on names (V2 keys = what save ops and create specs take).

import { CliError } from "@belzabar/core";
import { adApi } from "./api/index";
import type { HydratedMethod } from "./types/common";

/**
 * V2, fresh (never the V1-shaped cache). Falls back to the V1 parse only when
 * the V2 route refuses the method (some old bodies fail the server's V2
 * conversion); an unknown uuid still fails.
 */
export async function fetchViewMethod(uuid: string, warn: (m: string) => void): Promise<HydratedMethod> {
  try {
    return await adApi.fetchMethod(uuid, "v2");
  } catch (err) {
    if (err instanceof CliError && err.code === "METHOD_NOT_FOUND") throw err;
    warn(`V2 read failed (${(err as Error).message}); showing the V1 parse, whose input names are UI labels, not save keys.`);
    return adApi.fetchMethod(uuid, "v1");
  }
}
