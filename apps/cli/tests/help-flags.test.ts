// `--help` anywhere must show help instead of running the command.
// Spawns the dev CLI in an isolated HOME/cwd so no real ~/.wi-impl or .env is read.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");
const home = mkdtempSync(join(tmpdir(), "wi-impl-help-test-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
// wi-impl has no built-in envs: give the spawned CLI two to pick from.
mkdirSync(join(home, ".wi-impl"), { recursive: true });
writeFileSync(
  join(home, ".wi-impl", "config.json"),
  JSON.stringify({ environments: { dev: { url: "https://dev.example.test" }, qa: { url: "https://qa.example.test" } } }),
);

async function cli(...args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, WI_IMPL_HOME: join(home, ".wi-impl"), EDITOR: "false", VISUAL: "false" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("runner-level --help", () => {
  test("config token --help prints help, never a token", async () => {
    const r = await cli("config", "token", "--help", "--llm");
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.schema).toBe("wi-impl.help");
    expect(env.data.help).toContain("Usage: wi-impl config");
    expect(r.stdout).not.toMatch(/"token"\s*:/);
  }, 30_000);

  for (const args of [["config", "edit", "--help"], ["config", "get", "-h"]]) {
    test(`${args.join(" ")} shows help`, async () => {
      const r = await cli(...args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`wi-impl ${args[0]} `);
      expect(r.stdout).toContain("Subcommands:");
      expect(r.stdout + r.stderr).not.toContain("Unknown flag");
    }, 30_000);
  }
});

describe("global --env forms", () => {
  test("--env=<name> is honoured", async () => {
    const r = await cli("envs", "--env=qa", "--llm");
    // `envs` is not env-aware (no meta.env); it reports the selected env as data.active.
    expect(JSON.parse(r.stdout).data.active).toBe("qa");
  }, 30_000);

  test("conflicting --env is rejected with INVALID_ARGS", async () => {
    const r = await cli("envs", "--env", "dev", "--env=qa", "--llm");
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("INVALID_ARGS");
  }, 30_000);
});
