import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hasHelpFlag, parseGlobalFlags } from "../src/runner";

const HARNESS = join(import.meta.dir, "fixtures", "runner-harness.ts");
const home = mkdtempSync(join(tmpdir(), "wi-impl-runner-test-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const childEnv = { ...process.env, HOME: home, WI_IMPL_HOME: join(home, ".wi-impl") };

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run the harness with stdout piped into a reader that waits before draining. */
async function runPipedSlow(args: string[], extraEnv: Record<string, string> = {}) {
  const cmd = `${shq(process.execPath)} ${shq(HARNESS)} ${args.map(shq).join(" ")} | (sleep 0.4; cat)`;
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: home,
    env: { ...childEnv, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout, stderr };
}

async function runHarness(args: string[], extraEnv: Record<string, string> = {}, cwd = home) {
  const proc = Bun.spawn([process.execPath, HARNESS, ...args], {
    cwd,
    env: { ...childEnv, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("runner output flushing", () => {
  test("--llm envelope larger than 64 KiB arrives complete through a slow pipe", async () => {
    const { stdout } = await runPipedSlow(["big", "--llm"]);
    expect(stdout.length).toBeGreaterThan(300_000);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.data.payload.length).toBe(300_000);
    expect(env.data.tail).toBe("END");
  }, 20_000);

  test("human output larger than 64 KiB arrives complete through a slow pipe", async () => {
    const { stdout } = await runPipedSlow(["big"]);
    expect(stdout.length).toBeGreaterThan(300_000);
    expect(stdout.trimEnd().endsWith("END")).toBe(true);
  }, 20_000);

  test("exit code is preserved after flushing", async () => {
    const r = await runHarness(["nope", "--llm"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("UNKNOWN_COMMAND");
  }, 20_000);
});

describe("agent sessions default to --llm output", () => {
  const isEnvelope = (s: string) => {
    try { return JSON.parse(s).error?.code === "UNKNOWN_COMMAND"; } catch { return false; }
  };

  test("CLAUDECODE=1 or WI_IMPL_AGENT=1 → envelope without --llm", async () => {
    expect(isEnvelope((await runHarness(["nope"], { CLAUDECODE: "1" })).stdout)).toBe(true);
    expect(isEnvelope((await runHarness(["nope"], { WI_IMPL_AGENT: "1" })).stdout)).toBe(true);
  }, 20_000);

  test("no agent, --human, or WI_IMPL_AGENT=0 → human output", async () => {
    expect(isEnvelope((await runHarness(["nope"])).stdout)).toBe(false);
    expect(isEnvelope((await runHarness(["nope", "--human"], { CLAUDECODE: "1" })).stdout)).toBe(false);
    expect(isEnvelope((await runHarness(["nope"], { CLAUDECODE: "1", WI_IMPL_AGENT: "0" })).stdout)).toBe(false);
  }, 20_000);

  test("a CLAUDECODE injected by a cwd .env is ignored", async () => {
    const dir = mkdtempSync(join(home, "dotenv-"));
    writeFileSync(join(dir, ".env"), "CLAUDECODE=1\n");
    expect(isEnvelope((await runHarness(["nope"], { CLAUDECODE: "1" }, dir)).stdout)).toBe(false);
  }, 20_000);
});

describe("parseGlobalFlags", () => {
  test("output mode: default, --llm, --human, and both together", () => {
    expect(parseGlobalFlags(["envs"]).outputMode).toBe("human");
    expect(parseGlobalFlags(["envs"], "llm").outputMode).toBe("llm");
    expect(parseGlobalFlags(["envs", "--human"], "llm").outputMode).toBe("human");
    expect(parseGlobalFlags(["envs", "--llm"]).outputMode).toBe("llm");
    expect(parseGlobalFlags(["envs", "--llm", "--human"]).error?.code).toBe("INVALID_ARGS");
  });

  test("--env <name>", () => {
    const r = parseGlobalFlags(["ad", "show", "x", "--env", "acme-dev"]);
    expect(r.envName).toBe("acme-dev");
    expect(r.args).toEqual(["ad", "show", "x"]);
    expect(r.error).toBeNull();
  });

  test("--env=<name>", () => {
    const r = parseGlobalFlags(["ad", "show", "x", "--env=acme-dev", "--llm"]);
    expect(r.envName).toBe("acme-dev");
    expect(r.outputMode).toBe("llm");
    expect(r.args).toEqual(["ad", "show", "x"]);
  });

  test("-e <name>", () => {
    const r = parseGlobalFlags(["-e", "orb-qa", "envs"]);
    expect(r.envName).toBe("orb-qa");
    expect(r.args).toEqual(["envs"]);
  });

  test("-v / --verbose and --llm anywhere are stripped", () => {
    const r = parseGlobalFlags(["-v", "pd", "--llm", "show", "--verbose"]);
    expect(r.verbose).toBe(true);
    expect(r.outputMode).toBe("llm");
    expect(r.args).toEqual(["pd", "show"]);
  });

  test("duplicate --env is INVALID_ARGS", () => {
    expect(parseGlobalFlags(["envs", "--env", "a", "--env", "a"]).error?.code).toBe("INVALID_ARGS");
    expect(parseGlobalFlags(["envs", "--env=a", "-e", "a"]).error?.code).toBe("INVALID_ARGS");
  });

  test("conflicting --env is INVALID_ARGS", () => {
    const r = parseGlobalFlags(["envs", "--env", "orb-dev", "--env=acme-dev"]);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(r.error?.message.toLowerCase()).toContain("conflicting");
    expect(r.error?.message).not.toMatch(/^Error:/);
  });

  test("missing value is MISSING_ENV_ARG", () => {
    expect(parseGlobalFlags(["envs", "--env"]).error?.code).toBe("MISSING_ENV_ARG");
    expect(parseGlobalFlags(["envs", "--env="]).error?.code).toBe("MISSING_ENV_ARG");
    expect(parseGlobalFlags(["envs", "--env", "--llm"]).error?.code).toBe("MISSING_ENV_ARG");
  });

  test("parsing stops at --", () => {
    const r = parseGlobalFlags(["ad", "run", "--env", "x", "--", "--env", "y", "--llm", "-v"]);
    expect(r.envName).toBe("x");
    expect(r.error).toBeNull();
    expect(r.outputMode).toBe("human");
    expect(r.verbose).toBe(false);
    expect(r.args).toEqual(["ad", "run", "--", "--env", "y", "--llm", "-v"]);
  });
});

describe("help handling", () => {
  test("hasHelpFlag finds -h/--help anywhere before --", () => {
    expect(hasHelpFlag(["token", "--help"])).toBe(true);
    expect(hasHelpFlag(["search", "foo", "-h"])).toBe(true);
    expect(hasHelpFlag(["search", "--", "--help"])).toBe(false);
    expect(hasHelpFlag(["search", "foo --help"])).toBe(false);
  });

  test("top-level command with trailing --help shows help and does not execute", async () => {
    const r = await runHarness(["secret", "sub", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("HARNESS HELP TEXT");
    expect(r.stdout).not.toContain("SECRET-TOKEN-VALUE");
  }, 20_000);

  test("passthrough module sub-command with --help (config token --help shape)", async () => {
    const r = await runHarness(["mod", "token", "--help", "--llm"]);
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.data.help).toBe("HARNESS HELP TEXT");
    expect(r.stdout).not.toContain("SECRET-TOKEN-VALUE");
  }, 20_000);

  test("--help after -- is passed to the command", async () => {
    const r = await runHarness(["secret", "--", "--help", "--llm"]);
    expect(r.stdout).toContain("SECRET-TOKEN-VALUE");
  }, 20_000);
});
