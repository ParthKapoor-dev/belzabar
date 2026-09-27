// Envelope contract: every registered command's `--llm` output validates
// against core's EnvelopeSchema, `ok:false` ⇔ nonzero exit, and stdout is the
// envelope and nothing else. `web/` and the agent skills parse this output.
//
// No network: fetch is replaced by a fakeFetch with no routes (any request
// fails inside the command), process spawning is blocked, cwd is a tmp dir.
// Covered per command: `--help`, and the bare invocation (no args), which for
// nearly every command is a missing-argument error path.
//
// KNOWN_VIOLATIONS lists invocations that break the contract today. They run
// as test.todo; Stage 3 (envelope/UI) fixes them and deletes the entries.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EnvelopeSchema,
  fakeFetch,
  loadDevCliOptions,
  withTempEnvConfig,
  type TempEnvConfig,
  runCliInProcess,
  type FakeFetch,
  type RunResult,
} from "@belzabar/core/testing";
import type { NamespacedCliOptions } from "@belzabar/core";

const options: NamespacedCliOptions = await loadDevCliOptions();

/** Commands whose bare invocation must never run, even offline (installers, config writers, browser/OS side effects). */
const NO_BARE_RUN = new Set(["update", "setup", "onboard", "cache", "web", "extension"]);

/** argv (joined by spaces) → why it currently violates the contract. */
const KNOWN_VIOLATIONS: Record<string, string> = {};

interface Case {
  argv: string[];
  /** bare-env: bare invocation against a configured fake env, so network paths reach fakeFetch and fail there. */
  kind: "help" | "bare" | "bare-env" | "runner";
}

const FAKE_ENV = "contract-dev";

function buildCases(): Case[] {
  const cases: Case[] = [
    { argv: [], kind: "runner" },
    { argv: ["no-such-command"], kind: "runner" },
    { argv: ["--env", "no-such-env", "envs"], kind: "runner" },
  ];
  for (const [ns, def] of Object.entries(options.namespaces)) {
    if (def.commands) {
      cases.push({ argv: [ns], kind: "runner" }, { argv: [ns, "no-such-command"], kind: "runner" });
      for (const cmd of Object.keys(def.commands)) {
        cases.push({ argv: [ns, cmd, "--help"], kind: "help" });
        if (!NO_BARE_RUN.has(cmd)) {
          cases.push({ argv: [ns, cmd], kind: "bare" }, { argv: [ns, cmd, "--env", FAKE_ENV], kind: "bare-env" });
        }
      }
    } else {
      cases.push({ argv: [ns, "--help"], kind: "help" });
      if (!NO_BARE_RUN.has(ns)) {
        cases.push({ argv: [ns], kind: "bare" }, { argv: [ns, "--env", FAKE_ENV], kind: "bare-env" });
      }
    }
  }
  for (const cmd of Object.keys(options.topLevel)) {
    cases.push({ argv: [cmd, "--help"], kind: "help" });
    if (!NO_BARE_RUN.has(cmd)) {
      cases.push({ argv: [cmd], kind: "bare" }, { argv: [cmd, "--env", FAKE_ENV], kind: "bare-env" });
    }
  }
  return cases;
}

/** Contract violations for one run (empty = passes). */
function violations(c: Case, r: RunResult): string[] {
  const out: string[] = [];
  if (!r.envelope) return [`no envelope (human-only output in --llm mode)`];
  let wire: unknown;
  try {
    wire = JSON.parse(r.stdout);
  } catch {
    out.push(`stdout is not a single JSON document: ${JSON.stringify(r.stdout.slice(0, 200))}`);
  }
  if (wire !== undefined && JSON.stringify(wire) !== JSON.stringify(r.envelope)) out.push("stdout differs from envelope");
  const parsed = EnvelopeSchema.safeParse(r.envelope);
  if (!parsed.success) {
    out.push(...parsed.error.issues.map(i => `schema: ${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  if (r.envelope.ok !== (r.exitCode === 0)) out.push(`ok=${r.envelope.ok} but exitCode=${r.exitCode}`);
  if (c.kind === "help" && !(r.envelope.ok && r.exitCode === 0)) out.push("--help did not succeed");
  return out;
}

let ff: FakeFetch;
let cfg: TempEnvConfig;
let cwd: string;
let prevCwd: string;
const realSpawn = Bun.spawn;
const realSpawnSync = Bun.spawnSync;
const cp = require("node:child_process");
const realCp = { spawn: cp.spawn, spawnSync: cp.spawnSync, exec: cp.exec, execSync: cp.execSync, execFile: cp.execFile };

beforeAll(() => {
  ff = fakeFetch([]).install();
  cfg = withTempEnvConfig({
    envs: { [FAKE_ENV]: { url: "https://contract.test" } },
    teamwork: { email: "t@contract.test", password: btoa("x") },
    jenkins: { baseUrl: "https://jenkins.contract.test", user: "u", password: btoa("x") },
  });
  prevCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "belz-contract-cwd-"));
  process.chdir(cwd);
  const blocked = (name: string) => () => {
    throw new Error(`envelope-contract: ${name} is blocked in contract tests`);
  };
  (Bun as any).spawn = blocked("Bun.spawn");
  (Bun as any).spawnSync = blocked("Bun.spawnSync");
  for (const k of Object.keys(realCp)) cp[k] = blocked(`child_process.${k}`);
});

afterAll(() => {
  ff.restore();
  cfg.restore();
  (Bun as any).spawn = realSpawn;
  (Bun as any).spawnSync = realSpawnSync;
  Object.assign(cp, realCp);
  process.chdir(prevCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe("dev entry loads every command dir", () => {
  // loadCommandsFromDir swallows import errors; a broken command would silently vanish.
  for (const [ns, def] of Object.entries(options.namespaces)) {
    if (!def.commands || !def.helpDir) continue;
    test(`${ns}: every commands/<name>/index.ts is registered`, () => {
      const onDisk = readdirSync(def.helpDir!, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(def.helpDir!, e.name, "index.ts")))
        .map(e => e.name)
        .sort();
      expect(Object.keys(def.commands!).sort()).toEqual(onDisk);
    });
  }
});

describe("--llm envelope contract", () => {
  for (const c of buildCases()) {
    const key = c.argv.join(" ");
    const name = `belz ${key} --llm`.replace(/\s+/g, " ");
    if (KNOWN_VIOLATIONS[key]) {
      test.todo(`${name}  [known: ${KNOWN_VIOLATIONS[key]}]`, () => {});
      continue;
    }
    test(name, async () => {
      const r = await runCliInProcess(options, c.argv);
      expect({ argv: key, violations: violations(c, r) }).toEqual({ argv: key, violations: [] });
    }, 15_000);
  }
});

describe("harness sanity", () => {
  // Runs after the contract cases (same file ⇒ declaration order): the bare-env
  // runs must actually have reached the (routeless) fake network.
  test("bare-env invocations exercised network error paths", () => {
    const hosts = new Set(ff.unmatched.map(r => new URL(r.url).hostname));
    expect(hosts.has("contract.test")).toBe(true);
  });
});
