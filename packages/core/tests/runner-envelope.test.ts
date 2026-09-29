// Stage 3 envelope / human-output / global-flag contract of the runner
// (CORE-6/7/9/23/24/26, F31/F32/F38, D6). In-process via core/testing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CliError,
  Config,
  defineArgs,
  EnvelopeSchema,
  fail,
  failWithData,
  lifecycle,
  normalizeDetails,
  printErr,
  ok,
  setOutputMode,
  type CommandModule,
  type NamespacedCliOptions,
} from "../src/index";
import { runCliInProcess, runCommand, withTempEnvConfig, type TempEnvConfig } from "../src/testing";

let cfg: TempEnvConfig | null = null;
const savedBelzEnv = process.env.BELZ_ENV;
const envConfig = () =>
  withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" }, "t-qa": { url: "https://q.test" } }, defaultEnv: "t-dev" });
/** Set BELZ_ENV and reload config (it is read at load time). */
function setBelzEnv(value: string) {
  process.env.BELZ_ENV = value;
  cfg?.restore();
  cfg = envConfig();
}
beforeEach(() => {
  delete process.env.BELZ_ENV;
  cfg = envConfig();
});
afterEach(() => {
  cfg?.restore();
  cfg = null;
  if (savedBelzEnv === undefined) delete process.env.BELZ_ENV;
  else process.env.BELZ_ENV = savedBelzEnv;
});

const probe: CommandModule<string[], unknown> = {
  parseArgs: (a) => a,
  execute: (args, ctx) => ok({ args, env: ctx.env.name, envExplicit: ctx.envExplicit, verbose: ctx.verbose }),
};

function cli(extra: Partial<NamespacedCliOptions> = {}): NamespacedCliOptions {
  return {
    name: "t",
    description: "t",
    binaryName: "belz",
    namespaces: {
      ad: { name: "AD", description: "ad", commands: { show: probe, save: { ...probe, writes: true } } },
      tw: { name: "TW", description: "tw", commands: { task: probe }, envAware: false },
      config: { name: "Config", description: "cfg", command: { ...probe, envAware: false } },
    },
    topLevel: { envs: { ...probe, envAware: false }, cache: probe },
    build: { version: "9.9.9", sha: "abc1234" },
    ...extra,
  };
}

describe("envelope naming and version (CORE-23)", () => {
  test("schema is <namespace>.<command>, derived from routing; version 2.0", async () => {
    const legacy: CommandModule = { schema: "belz.migrate.status", version: "1.0", execute: () => ok(1) };
    const opts = cli();
    opts.namespaces.migrate = { name: "M", description: "m", commands: { status: legacy } };
    for (const [argv, schema] of [
      [["ad", "show", "x"], "ad.show"],
      [["tw", "task", "1"], "tw.task"],
      [["migrate", "status"], "migrate.status"],
      [["config", "get"], "belz.config"],
      [["envs"], "belz.envs"],
      [["cache"], "belz.cache"],
    ] as const) {
      const r = await runCliInProcess(opts, [...argv]);
      expect(r.envelope?.schema).toBe(schema);
      expect(r.envelope?.version).toBe("2.0");
      expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    }
  });

  test("runner-level envelopes: belz.help / belz.runner / belz.version, with durationMs, no env", async () => {
    for (const [argv, schema, okv] of [
      [[], "belz.help", true],
      [["ad"], "belz.help", true],
      [["ad", "show", "--help"], "belz.help", true],
      [["nope"], "belz.runner", false],
      [["ad", "nope"], "belz.runner", false],
      [["envs", "--env", "no-such"], "belz.runner", false],
      [["envs", "--env"], "belz.runner", false],
      [["--version"], "belz.version", true],
    ] as const) {
      const r = await runCliInProcess(cli(), [...argv]);
      expect(r.envelope?.schema).toBe(schema);
      expect(r.envelope?.ok).toBe(okv);
      expect(typeof r.envelope?.meta.durationMs).toBe("number");
      expect(r.envelope?.meta.env).toBeUndefined();
      expect(r.envelope?.error?.message ?? "").not.toMatch(/^Error/);
      expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    }
  });
});

describe("meta.env only for env-aware commands", () => {
  test("AD command carries env; tw namespace, envAware:false commands and passthrough do not", async () => {
    expect((await runCliInProcess(cli(), ["ad", "show", "--env", "t-dev"])).envelope?.meta.env).toBe("t-dev");
    expect((await runCliInProcess(cli(), ["tw", "task"])).envelope?.meta.env).toBeUndefined();
    expect((await runCliInProcess(cli(), ["envs"])).envelope?.meta.env).toBeUndefined();
    expect((await runCliInProcess(cli(), ["config", "get"])).envelope?.meta.env).toBeUndefined();
    // a command's own meta.env is not trusted over the runner's decision
    const liar: CommandModule = { envAware: false, execute: () => ok(1, { env: "nsm-dev" }) };
    expect((await runCommand(liar)).envelope?.meta.env).toBeUndefined();
  });
});

describe("errors (CORE-9, F38)", () => {
  test("details are always an object", () => {
    expect(normalizeDetails("plain")).toEqual({ text: "plain" });
    expect(normalizeDetails('{"a":1}')).toEqual({ a: 1 });
    expect(normalizeDetails("[1]")).toEqual({ text: "[1]" });
    expect(normalizeDetails([1, 2])).toEqual({ items: [1, 2] });
    expect(normalizeDetails(7)).toEqual({ value: 7 });
    expect(normalizeDetails({ k: 1 })).toEqual({ k: 1 });
    expect(normalizeDetails(undefined)).toBeUndefined();
  });

  test("string details from fail() and CliError reach the wire as objects; Error: prefix stripped", async () => {
    const a = await runCommand({ execute: () => fail("HTTP_ERROR", "Error: boom", { details: '{"status":500}' }) });
    expect(a.envelope?.error).toEqual({ code: "HTTP_ERROR", message: "boom", details: { status: 500 } });
    const b = await runCommand({
      execute: () => {
        throw new CliError("bad", { code: "X", details: "raw text" });
      },
    });
    expect(b.envelope?.error?.details).toEqual({ text: "raw text" });
    expect(EnvelopeSchema.safeParse(b.envelope).success).toBe(true);
  });

  test("exit code honours CliError.exitCode (USER_ABORT → 130)", async () => {
    const r = await runCommand({
      execute: () => {
        throw new CliError("Aborted by user.", { code: "USER_ABORT", exitCode: 130 });
      },
    });
    expect(r.exitCode).toBe(130);
    expect(r.envelope?.ok).toBe(false);
  });

  test("unhandled exception includes the stack only with -v", async () => {
    const boom: CommandModule = {
      execute: () => {
        throw new Error("kaput");
      },
    };
    const quiet = await runCommand(boom);
    expect(quiet.envelope?.error?.details).toBeUndefined();
    const loud = await runCommand(boom, ["-v"]);
    expect(String((loud.envelope?.error?.details as any)?.stack)).toContain("kaput");
    expect(EnvelopeSchema.safeParse(loud.envelope).success).toBe(true);
  });

  test("failWithData: ok:false + data, exit 1, presenter still renders, error on stderr", async () => {
    const validate: CommandModule<unknown, { errors: number }> = {
      execute: () => failWithData("VALIDATION_FAILED", "2 errors found.", { errors: 2 }),
      presentHuman: (env, ui) => ui.text(`errors=${(env.data as any).errors}`),
    };
    const llm = await runCommand(validate);
    expect(llm.exitCode).toBe(1);
    expect(llm.envelope).toMatchObject({ ok: false, data: { errors: 2 }, error: { code: "VALIDATION_FAILED" } });
    expect(EnvelopeSchema.safeParse(llm.envelope).success).toBe(true);
    const human = await runCommand(validate, [], { llm: false });
    expect(human.stdout).toContain("errors=2");
    expect(human.stdout).not.toContain("2 errors found.");
    expect(human.stderr).toContain("2 errors found.");
  });
});

describe("human output streams (F31, CORE-6, F32)", () => {
  test("errors go to stderr, stdout stays empty", async () => {
    const r = await runCommand({ execute: () => fail("NOPE", "it broke", { details: "why" }) }, [], { llm: false });
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("it broke");
    expect(r.stderr).toContain("why");
  });

  test("unknown command (human) → stderr message", async () => {
    const r = await runCliInProcess(cli(), ["nope"], { llm: false });
    expect(r.stderr).toContain("Unknown module or command");
    expect(r.exitCode).toBe(1);
  });

  test("warnings are printed to stderr after the presenter", async () => {
    const warned: CommandModule = {
      execute: (_a, ctx) => {
        ctx.warn("stale cache");
        return ok(1, { warnings: ["from meta"] });
      },
      presentHuman: (_e, ui) => ui.text("RESULT"),
    };
    const r = await runCommand(warned, [], { llm: false });
    expect(r.stdout).toContain("RESULT");
    expect(r.stdout).not.toContain("stale cache");
    expect(r.stderr).toContain("stale cache");
    expect(r.stderr).toContain("from meta");
    const llm = await runCommand(warned);
    expect(llm.envelope?.meta.warnings).toEqual(["from meta", "stale cache"]);
  });

  test("spinner writes no frames or escape codes when stdout is not a TTY", async () => {
    const spinning: CommandModule = {
      envAware: false, // no default-env notice on stderr: this test is about the spinner
      execute: async () => {
        const s = lifecycle.spinner("working");
        s.start();
        s.message("still working");
        await new Promise((r) => setTimeout(r, 120));
        s.stop("done working");
        return ok("x");
      },
      presentHuman: (_e, ui) => ui.text("RESULT"),
    };
    const r = await runCommand(spinning, [], { llm: false });
    expect(r.stdout).toBe("RESULT\n");
    expect(r.stderr).toBe("done working\n");
    // eslint-disable-next-line no-control-regex
    expect(/\x1b/.test(r.stdout + r.stderr)).toBe(false);
    setOutputMode("human");
  });
});

describe("help is plain text off a TTY, even with FORCE_COLOR (CLI trial)", () => {
  test("--help, <module> --help, <cmd> --help, --help-full: no escape codes when stdout is a pipe", async () => {
    const saved = { force: process.env.FORCE_COLOR, tty: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
    process.env.FORCE_COLOR = "3";
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      const opts = cli({ helpFull: () => "\x1b[1mFULL\x1b[22m" });
      opts.namespaces.ad!.helpResolver = async () => "\x1b[31mUsage: belz ad show\x1b[39m";
      for (const argv of [["--help"], ["ad", "--help"], ["ad", "show", "--help"], ["--help-full"]]) {
        const r = await runCliInProcess(opts, argv, { llm: false });
        expect(r.stdout.length).toBeGreaterThan(0);
        // eslint-disable-next-line no-control-regex
        expect(/\x1b\[/.test(r.stdout)).toBe(false);
      }
    } finally {
      if (saved.force === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved.force;
      if (saved.tty) Object.defineProperty(process.stdout, "isTTY", saved.tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});

describe("printErr (F32)", () => {
  test("strips ANSI when stderr is not a TTY, unless FORCE_COLOR", () => {
    const saved = { error: console.error, force: process.env.FORCE_COLOR };
    const lines: string[] = [];
    console.error = (s: string) => lines.push(s);
    try {
      delete process.env.FORCE_COLOR;
      printErr("\x1b[31mred\x1b[39m");
      process.env.FORCE_COLOR = "1";
      printErr("\x1b[31mred\x1b[39m");
    } finally {
      console.error = saved.error;
      if (saved.force === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved.force;
    }
    expect(lines).toEqual(["red", "\x1b[31mred\x1b[39m"]);
  });
});

describe("--version (CORE-24)", () => {
  test("human and --llm", async () => {
    const h = await runCliInProcess(cli(), ["--version"], { llm: false });
    expect(h.stdout.trim()).toBe("belz 9.9.9 (abc1234)");
    const l = await runCliInProcess(cli(), ["--version"]);
    expect(l.envelope?.data).toMatchObject({ name: "belz", version: "9.9.9", sha: "abc1234" });
  });

  test("a command's own --version flag is not intercepted", async () => {
    const r = await runCliInProcess(cli(), ["ad", "show", "--version", "3"]);
    expect((r.envelope?.data as any).args).toEqual(["--version", "3"]);
  });
});

describe("global flags (CORE-7)", () => {
  const owner = { ...probe, ownsFlags: ["-v", "--verbose"] };

  test("-v after the command goes to a command that declares it (ownsFlags)", async () => {
    const opts = cli();
    opts.namespaces.ad!.commands!.test = owner;
    const r = await runCliInProcess(opts, ["ad", "test", "x", "--verbose", "y"]);
    expect((r.envelope?.data as any).args).toEqual(["x", "--verbose", "y"]);
    expect((r.envelope?.data as any).verbose).toBe(false);
  });

  test("-v declared in the module's exported args spec is handed over", async () => {
    const opts = cli();
    opts.namespaces.ad!.commands!.test = {
      default: probe,
      args: defineArgs({ flags: { verbose: { type: "boolean", alias: ["-v"] } }, positionals: [{ name: "x" }] }),
    };
    const r = await runCliInProcess(opts, ["ad", "test", "-v", "x"]);
    expect((r.envelope?.data as any).args).toEqual(["-v", "x"]);
  });

  test("-v before the command is global even for owners; non-owners never see it", async () => {
    const opts = cli();
    opts.namespaces.ad!.commands!.test = owner;
    const g = await runCliInProcess(opts, ["-v", "ad", "test", "x"]);
    expect((g.envelope?.data as any).args).toEqual(["x"]);
    expect((g.envelope?.data as any).verbose).toBe(true);
    const n = await runCliInProcess(opts, ["ad", "show", "x", "-v"]);
    expect((n.envelope?.data as any).args).toEqual(["x"]);
    expect((n.envelope?.data as any).verbose).toBe(true);
  });

  test("values after -- are untouched, including --llm / -v / --env", async () => {
    const r = await runCliInProcess(cli(), ["ad", "show", "q", "--", "--llm", "-v", "--env", "x"]);
    expect((r.envelope?.data as any).args).toEqual(["q", "--", "--llm", "-v", "--env", "x"]);
    expect((r.envelope?.data as any).verbose).toBe(false);
  });
});

describe("default env + explicit env on writes (D6, CORE-26)", () => {
  test("a write without --env → ENV_REQUIRED_FOR_WRITE naming the default env", async () => {
    const r = await runCliInProcess(cli(), ["ad", "save", "x"]);
    expect(r.exitCode).toBe(1);
    expect(r.envelope?.error?.code).toBe("ENV_REQUIRED_FOR_WRITE");
    expect(r.envelope?.error?.message).toContain(`--env ${Config.activeEnv.name}`);
    expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
  });

  test("a write with --env runs; human mode prints the target env header on stderr", async () => {
    const r = await runCliInProcess(cli(), ["ad", "save", "x", "--env", "t-qa"]);
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).envExplicit).toBe(true);
    const h = await runCliInProcess(cli(), ["ad", "save", "x", "--env", "t-qa"], { llm: false });
    expect(h.stderr).toContain("target env: t-qa (https://q.test)");
    expect(h.stdout).not.toContain("target env");
  });

  test("writes may depend on parsed args", async () => {
    const sql: CommandModule<string[], unknown> = { ...probe, writes: (a) => a[0] === "insert" };
    const opts = cli();
    opts.namespaces.ad!.commands!.sql = sql;
    expect((await runCliInProcess(opts, ["ad", "sql", "run"])).envelope?.ok).toBe(true);
    expect((await runCliInProcess(opts, ["ad", "sql", "insert"])).envelope?.error?.code).toBe("ENV_REQUIRED_FOR_WRITE");
  });

  test("writes on a non-env-aware command does not require --env (target comes from its own args)", async () => {
    const opts = cli();
    opts.namespaces.tw!.commands!.run = { ...probe, writes: true };
    expect((await runCliInProcess(opts, ["tw", "run"])).envelope?.ok).toBe(true);
  });

  test("writesLocal does not require --env", async () => {
    const opts = cli();
    opts.namespaces.tw!.commands!.freeze = { ...probe, writesLocal: true };
    expect((await runCliInProcess(opts, ["tw", "freeze"])).envelope?.ok).toBe(true);
  });

  test("reads use BELZ_ENV as the default env", async () => {
    setBelzEnv("t-qa");
    const r = await runCliInProcess(cli(), ["ad", "show"]);
    expect(r.envelope?.meta.env).toBe("t-qa");
    expect((r.envelope?.data as any).envExplicit).toBe(false);
    // explicit --env still wins
    expect((await runCliInProcess(cli(), ["ad", "show", "--env", "t-dev"])).envelope?.meta.env).toBe("t-dev");
  });

  test("requiresEnv (the dry run of a write reads the target env) needs --env too (CLI trial)", async () => {
    const dry: CommandModule<string[], unknown> = { ...probe, writes: false, requiresEnv: (a) => a[0] === "--dry-run" };
    const opts = cli();
    opts.namespaces.ad!.commands!.save = dry;
    const r = await runCliInProcess(opts, ["ad", "save", "--dry-run"]);
    expect(r.envelope?.error?.code).toBe("ENV_REQUIRED_FOR_WRITE");
    expect(r.envelope?.error?.details).toMatchObject({ dryRun: true });
    expect((await runCliInProcess(opts, ["ad", "save", "--dry-run", "--env", "t-qa"])).envelope?.ok).toBe(true);
    expect((await runCliInProcess(opts, ["ad", "save", "other"])).envelope?.ok).toBe(true);
    // a preview is not a write: no "target env" header
    const h = await runCliInProcess(opts, ["ad", "save", "--dry-run", "--env", "t-qa"], { llm: false });
    expect(h.stderr).not.toContain("target env");
  });

  test("meta.envSource says where the env came from; human reads on the default say so on stderr", async () => {
    const flag = await runCliInProcess(cli(), ["ad", "show", "--env", "t-dev"]);
    expect(flag.envelope?.meta).toMatchObject({ env: "t-dev", envSource: "flag" });
    const dflt = await runCliInProcess(cli(), ["ad", "show"]);
    expect(dflt.envelope?.meta.envSource).toBe("default");
    expect(EnvelopeSchema.safeParse(dflt.envelope).success).toBe(true);
    const h = await runCliInProcess(cli(), ["ad", "show"], { llm: false });
    expect(h.stderr).toContain(`env: ${Config.activeEnv.name} (`);
    expect(h.stderr).toContain("pass --env to choose");
    expect(h.stdout).not.toContain("pass --env");
    const hx = await runCliInProcess(cli(), ["ad", "show", "--env", "t-dev"], { llm: false });
    expect(hx.stderr).not.toContain("pass --env");
    // not env-aware: no env, no envSource
    const tw = await runCliInProcess(cli(), ["tw", "task"]);
    expect(tw.envelope?.ok).toBe(true);
    expect(tw.envelope?.meta.env).toBeUndefined();
    expect(tw.envelope?.meta.envSource).toBeUndefined();
    setBelzEnv("t-qa");
    expect((await runCliInProcess(cli(), ["ad", "show"])).envelope?.meta).toMatchObject({ env: "t-qa", envSource: "BELZ_ENV" });
  });

  test("an unknown default env fails env-aware commands only", async () => {
    setBelzEnv("no-such-env");
    const r = await runCliInProcess(cli(), ["ad", "show"]);
    expect(r.envelope?.error?.code).toBe("INVALID_ENV");
    expect(r.envelope?.error?.message).toContain("BELZ_ENV");
    expect((await runCliInProcess(cli(), ["envs"])).envelope?.ok).toBe(true);
    expect((await runCliInProcess(cli(), ["ad", "show", "--env", "t-dev"])).envelope?.ok).toBe(true);
  });

  test("no built-in env: several envs and no default → ENV_NOT_SELECTED listing them; --env still works", async () => {
    cfg?.restore();
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" }, "t-qa": { url: "https://q.test" } } });
    expect(Config.envSource).toBe("none");
    const r = await runCliInProcess(cli(), ["ad", "show"]);
    expect(r.exitCode).toBe(1);
    expect(r.envelope?.error?.code).toBe("ENV_NOT_SELECTED");
    expect(r.envelope?.error?.message).toContain("t-dev, t-qa");
    expect(r.envelope?.error?.message).toContain("--env");
    expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    expect((await runCliInProcess(cli(), ["ad", "show", "--env", "t-qa"])).envelope?.meta.env).toBe("t-qa");
    // not env-aware commands are unaffected
    const twr = await runCliInProcess(cli(), ["tw", "task"]); expect(twr.envelope?.error ?? null).toBeNull();
  });

  test("a single configured env is the default without defaultEnv", async () => {
    cfg?.restore();
    cfg = withTempEnvConfig({ envs: { solo: { url: "https://solo.test" } } });
    const r = await runCliInProcess(cli(), ["ad", "show"]);
    expect(r.envelope?.meta).toMatchObject({ env: "solo", envSource: "default" });
    const h = await runCliInProcess(cli(), ["ad", "show"], { llm: false });
    expect(h.stderr).toContain("env: solo (the only configured env; pass --env to choose)");
  });

  test("no envs configured → ENV_NOT_SELECTED pointing at setup", async () => {
    cfg?.restore();
    cfg = withTempEnvConfig({ envs: {} });
    const r = await runCliInProcess(cli(), ["ad", "show"]);
    expect(r.envelope?.error?.code).toBe("ENV_NOT_SELECTED");
    expect(r.envelope?.error?.message).toContain("No environments configured");
  });
});
