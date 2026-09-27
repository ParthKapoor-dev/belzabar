// bun test preload: point BELZ_HOME at a throwaway dir before any module reads
// it, so no test in the process can touch the real ~/.belz. Wired via the
// bunfig.toml files at the repo root and in each integration/core dir.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

if (!process.env.BELZ_HOME) {
  const dir = mkdtempSync(join(tmpdir(), "belz-home-test-"));
  process.env.BELZ_HOME = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
}
