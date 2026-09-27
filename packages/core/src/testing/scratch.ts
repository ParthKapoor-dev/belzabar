import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * A fresh temp dir under the test run's tmp root (BELZ_TEST_TMP, set by the
 * bun test preload and removed after the run), else under the OS tmp dir.
 */
export function scratchDir(prefix = "scratch-"): string {
  return mkdtempSync(join(process.env.BELZ_TEST_TMP ?? tmpdir(), prefix));
}
