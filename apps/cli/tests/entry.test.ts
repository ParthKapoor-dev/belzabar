// The real entry point (bin/cli.ts), spawned: --version and the
// load-failure report.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { cliDir, cliEntry } from "@belzabar/core/testing";

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function run(entry: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: cliDir(),
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("bin/cli.ts", () => {
  test("--version prints version + git SHA; --llm gives a belz.version envelope", async () => {
    const h = await run(cliEntry(), ["--version"]);
    expect(h.exitCode).toBe(0);
    expect(h.stdout.trim()).toMatch(/^belz \d+\.\d+\.\d+ \(([0-9a-f]{7,}|unknown)(-dirty)?, built \d{4}-\d{2}-\d{2}\)$/);
    const l = await run(cliEntry(), ["--version", "--llm"]);
    const env = JSON.parse(l.stdout);
    expect(env.schema).toBe("belz.version");
    expect(env.data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof env.data.sha).toBe("string");
  }, 30_000);

  test("a command module that fails to load is reported on stderr", async () => {
    // A copy of the entry next to a broken options.ts, inside the workspace so
    // @belzabar/core still resolves.
    const dir = mkdtempSync(join(cliDir(), ".tmp-entry-"));
    tmpDirs.push(dir);
    copyFileSync(cliEntry(), join(dir, "cli.ts"));
    writeFileSync(join(dir, "options.ts"), `export { nope } from "./does-not-exist";\n`);
    const r = await run(join(dir, "cli.ts"), ["envs", "--llm"]);
    expect(r.exitCode).toBe(70);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("belz: failed to load the command registry");
  }, 30_000);
});
