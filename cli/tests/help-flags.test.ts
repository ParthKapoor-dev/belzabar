// F16: `--help` anywhere must show help instead of running the command.
// Spawns the dev CLI in an isolated HOME/cwd so no real ~/.belz or .env is read.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");
const home = mkdtempSync(join(tmpdir(), "belz-help-test-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function belz(...args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, BELZ_HOME: join(home, ".belz"), EDITOR: "false", VISUAL: "false" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("runner-level --help (F16)", () => {
  test("config token --help prints help, never a token", async () => {
    const r = await belz("config", "token", "--help", "--llm");
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.schema).toBe("belz.help");
    expect(env.data.help).toContain("Usage: belz config");
    expect(r.stdout).not.toMatch(/"token"\s*:/);
  }, 30_000);

  for (const args of [["config", "edit", "--help"], ["web", "status", "--help"], ["extension", "list", "--help"], ["config", "get", "-h"]]) {
    test(`${args.join(" ")} shows help`, async () => {
      const r = await belz(...args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`belz ${args[0]} `);
      expect(r.stdout).toContain("Subcommands:");
      expect(r.stdout + r.stderr).not.toContain("Unknown flag");
    }, 30_000);
  }
});

describe("global --env forms (F3)", () => {
  test("--env=<name> is honoured", async () => {
    const r = await belz("envs", "--env=nsm-qa", "--llm");
    expect(JSON.parse(r.stdout).meta.env).toBe("nsm-qa");
  }, 30_000);

  test("conflicting --env is rejected with INVALID_ARGS", async () => {
    const r = await belz("envs", "--env", "nsm-dev", "--env=nsm-qa", "--llm");
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("INVALID_ARGS");
  }, 30_000);
});
