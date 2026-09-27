// bun test preload: point BELZ_HOME at a throwaway dir before any module reads
// it, so no test in the process can touch the real ~/.belz. Wired via the
// bunfig.toml files at the repo root and in each integration/core dir.
//
// Layout: $BELZ_TEST_TMP/            (removed after the whole run)
//           home/                    BELZ_HOME
//           <scratch dirs>           core/testing scratchDir(): spawn homes, live config copies
//
// Cleanup uses a global afterAll (hooks registered in a preload run once, after
// all files): bun test does not fire process "exit" handlers.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

if (!process.env.BELZ_HOME) {
  const root = mkdtempSync(join(tmpdir(), "belz-home-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  process.env.BELZ_HOME = home;
  process.env.BELZ_TEST_TMP = root;
  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  afterAll(cleanup);
  process.on("exit", cleanup);
}
