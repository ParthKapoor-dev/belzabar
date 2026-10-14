// The preload must replace an exported WI_IMPL_HOME (it may be the
// developer's real belz home), and core/testing refuses any home outside the
// run's WI_IMPL_TEST_TMP.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join, resolve } from "path";
import { scratchDir } from "../src/testing/scratch";

const REPO = resolve(import.meta.dir, "../../..");

describe("test preload", () => {
  test("an exported WI_IMPL_HOME is replaced by a throwaway dir inside WI_IMPL_TEST_TMP", () => {
    const dir = scratchDir("preload-");
    const probe = join(dir, "probe.test.ts");
    writeFileSync(
      probe,
      `import { test } from "bun:test";\n` +
        `test("p", () => { console.log("HOME=" + process.env.WI_IMPL_HOME + "|TMP=" + process.env.WI_IMPL_TEST_TMP); });\n`,
    );
    const pretendRealHome = join(dir, "real-belz-home");
    const proc = Bun.spawnSync([process.execPath, "test", probe], {
      cwd: REPO,
      env: { ...process.env, WI_IMPL_HOME: pretendRealHome, WI_IMPL_TEST_TMP: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    const m = out.match(/HOME=(\S+)\|TMP=(\S+)/);
    expect(m).not.toBeNull();
    const [, home, tmp] = m!;
    expect(home).not.toBe(pretendRealHome);
    expect(home!.startsWith(tmp!)).toBe(true);
  }, 30_000);

  test("assertSafeBelzHome refuses a home outside WI_IMPL_TEST_TMP", async () => {
    const saved = process.env.WI_IMPL_TEST_TMP;
    process.env.WI_IMPL_TEST_TMP = scratchDir("elsewhere-");
    try {
      const { assertSafeBelzHome } = await import("../src/testing/env-config");
      expect(() => assertSafeBelzHome()).toThrow(/throwaway/);
    } finally {
      process.env.WI_IMPL_TEST_TMP = saved;
    }
  });
});
