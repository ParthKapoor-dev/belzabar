// The real, sanitized editor pages in tests/fixtures/real (one `<id>.json`
// per page or component, plus manifest.json).

import { readdirSync } from "fs";
import { jsonFixtures } from "@belzabar/core/testing";
import type { RawPageResponse } from "../../../lib/types/wire";

export const REAL_DIR = `${import.meta.dir}/../../fixtures/real`;

/** Every fixture file name (`<id>.json`), sorted. */
export const REAL_FILES = readdirSync(REAL_DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();

const read = jsonFixtures(REAL_DIR);

/** A real page by id or by file name. */
export function loadReal(idOrFile: string): RawPageResponse & Record<string, any> {
  return read(idOrFile.endsWith(".json") ? idOrFile : `${idOrFile}.json`);
}
