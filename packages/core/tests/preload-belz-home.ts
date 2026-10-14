// bun test preload: point WI_IMPL_HOME at a throwaway dir before any module reads
// it, so no test in the process can touch the real ~/.wi-impl. Wired via the
// bunfig.toml files at the repo root and in each integration/core dir.
//
// Layout: $WI_IMPL_TEST_TMP/            (removed after the whole run)
//           home/                    WI_IMPL_HOME
//           <scratch dirs>           core/testing scratchDir(): spawn homes, live config copies
//
// Cleanup uses a global afterAll (hooks registered in a preload run once, after
// all files): bun test does not fire process "exit" handlers.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Always override: an exported WI_IMPL_HOME may be the developer's real wi-impl
// home (e.g. WI_IMPL_HOME=/data/belz), and tests write config/sessions/caches
// into it. Tests that need a specific home set it per spawn.
{
  const root = mkdtempSync(join(tmpdir(), "wi-impl-home-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  // wi-impl has no built-in env: seed one neutral env so commands run in-process
  // have a default (the only configured env). Tests that need other envs use
  // core/testing withTempEnvConfig, which replaces and restores this file.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ environments: { test: { url: "https://test.example.test", user: "test-user", password: "test-password", passwordEncoding: "plain" } } }),
    { mode: 0o600 },
  );
  process.env.WI_IMPL_HOME = home;
  process.env.WI_IMPL_TEST_TMP = root;
  // Running the suite from an agent shell (CLAUDECODE=1) must not flip every
  // command's default output to --llm; tests that need it set it themselves.
  delete process.env.CLAUDECODE;
  delete process.env.WI_IMPL_AGENT;
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
