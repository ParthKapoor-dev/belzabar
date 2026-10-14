// Regression against the *compiled* binary: an `--llm` envelope
// larger than the 64 KiB pipe buffer must arrive complete through a slow pipe.
// Compiles bin/cli.ts into a tmp dir (≈1 s; nothing is installed).
// The big payload comes from `envs` over a config with ~1500 custom envs, so no
// network is involved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cliBuildEntry } from "@belzabar/core/testing";

const ENV_COUNT = 1500;
let dir: string;
let bin: string;

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wi-impl-compiled-"));
  bin = join(dir, "wi-impl");
  // cwd = the tmp dir: bun renames its temp output into place, which fails across filesystems.
  const build = Bun.spawnSync(
    [process.execPath, "build", "--compile", "--minify", cliBuildEntry(), "--outfile", bin],
    { cwd: dir, stdout: "pipe", stderr: "pipe" }
  );
  if (build.exitCode !== 0) throw new Error(`compile failed: ${build.stderr.toString()}`);

  const belzHome = join(dir, ".wi-impl");
  mkdirSync(belzHome, { recursive: true });
  const environments: Record<string, { url: string }> = {};
  for (let i = 0; i < ENV_COUNT; i++) {
    environments[`pipe-env-${i}`] = { url: `https://pipe-env-${i}.example.invalid/some/long/base/path/segment` };
  }
  writeFileSync(join(belzHome, "config.json"), JSON.stringify({ environments }));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("compiled binary", () => {
  test("--llm output > 64 KiB survives a slow pipe", async () => {
    const cmd = `${shq(bin)} envs --llm | (sleep 0.5; cat)`;
    const proc = Bun.spawn(["sh", "-c", cmd], {
      cwd: dir, // compiled binaries autoload .env from cwd: keep it empty
      env: { PATH: process.env.PATH ?? "", HOME: dir, WI_IMPL_HOME: join(dir, ".wi-impl") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.length).toBeGreaterThan(64 * 1024);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.data.envs.length).toBe(ENV_COUNT); // no built-in envs
  }, 30_000);

  test("--help-full arrives complete through a slow pipe", async () => {
    const proc = Bun.spawn(["sh", "-c", `${shq(bin)} --help-full | (sleep 0.5; cat)`], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, WI_IMPL_HOME: join(dir, ".wi-impl") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout.startsWith("NOTE FOR LLM AGENTS")).toBe(true);
    expect(stdout.trimEnd().endsWith("for full flag documentation and examples.")).toBe(true);
  }, 30_000);
});
