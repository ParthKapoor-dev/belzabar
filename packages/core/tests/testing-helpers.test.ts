// Tests for @belzabar/core/testing itself: fakeFetch, withTempEnvConfig,
// runCommand, EnvelopeSchema. Also exercises apiFetch/login end-to-end
// (IPv4 pinning + session + 401 re-login) with no network.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { apiFetch } from "../src/http/api";
import { CliError, fail, ok, type CommandModule } from "../src/command";
import { Config } from "../src/config";
import { EnvelopeSchema } from "../src/envelope";
import { setOutputMode } from "../src/ui";
import {
  fakeFetch,
  fixture,
  markLiveResourceCleaned,
  registerLiveResource,
  respond,
  runCommand,
  scratchDir,
  withTempEnvConfig,
  type FakeFetch,
  type TempEnvConfig,
} from "../src/testing";
import { join } from "path";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

describe("fakeFetch", () => {
  test("routes by method + path, records requests, restores fetch", async () => {
    const realFetch = globalThis.fetch;
    ff = fakeFetch({
      "GET /a/*": { hello: "world" },
      "POST https://x.test/b": (req: any) => ({ echoed: req.json() }),
      "/any-method": "plain",
    }).install();
    expect(globalThis.fetch).not.toBe(realFetch);

    expect(await (await fetch("https://x.test/a/1?q=2")).json()).toEqual({ hello: "world" });
    const r = await fetch("https://x.test/b", { method: "POST", body: JSON.stringify({ n: 1 }) });
    expect(await r.json()).toEqual({ echoed: { n: 1 } });
    expect(await (await fetch("https://x.test/any-method", { method: "DELETE" })).text()).toBe("plain");

    expect(ff.requests.map(r => `${r.method} ${r.url}`)).toEqual([
      "GET https://x.test/a/1?q=2",
      "POST https://x.test/b",
      "DELETE https://x.test/any-method",
    ]);
    expect(ff.calls("POST").length).toBe(1);

    ff.restore();
    expect(globalThis.fetch).toBe(realFetch);
  });

  test("unmatched request throws a clear error", async () => {
    ff = fakeFetch({ "GET /known": {} }).install();
    await expect(fetch("https://x.test/unknown", { method: "PUT" })).rejects.toThrow(
      /fakeFetch: no route for PUT https:\/\/x\.test\/unknown\. Registered: GET \/known/
    );
    expect(ff.unmatched.length).toBe(1);
  });

  test("respond(), fixture(), RegExp routes, once", async () => {
    const fx = join(process.env.BELZ_HOME!, "fake-fetch-sample.json");
    writeFileSync(fx, JSON.stringify({ sample: [1, 2, 3] }));
    ff = fakeFetch([
      { method: "GET", url: /\/status$/, response: respond({ status: 418, text: "teapot" }), once: true },
      { method: "GET", url: /\/status$/, response: respond({ json: { ok: 1 }, headers: { "x-h": "1" } }) },
      { url: "/fx", response: fixture(fx) },
    ]).install();
    const first = await fetch("https://x.test/status");
    expect(first.status).toBe(418);
    const second = await fetch("https://x.test/status");
    expect(second.headers.get("x-h")).toBe("1");
    expect(await second.json()).toEqual({ ok: 1 });
    expect(await (await fetch("https://x.test/fx")).json()).toEqual(JSON.parse(readFileSync(fx, "utf8")));
  });
});

describe("apiFetch via fakeFetch + withTempEnvConfig", () => {
  test("uses the saved session token, pins IPv4 but matches the logical URL", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: "tok-1" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ "GET /rest/thing": { id: 7 } }).install();
    const res = await apiFetch("/rest/thing");
    expect(await res.json()).toEqual({ id: 7 });
    const [req] = ff.requests;
    expect(req!.url).toBe("https://t-dev.test/rest/thing");
    expect(req!.wireUrl).toContain("127.0.0.2");
    expect(req!.headers["authorization"]).toBe("Bearer tok-1");
  });

  test("401 → login → retry with the new token", async () => {
    cfg = withTempEnvConfig({
      envs: { "t-dev": { url: "https://t-dev.test", token: "stale", user: "u1", password: "p1" } },
      activeEnv: "t-dev",
    });
    ff = fakeFetch([
      { method: "GET", url: "/rest/x", response: respond({ status: 401, text: "no" }), once: true },
      { method: "POST", url: "/do/login", response: { token: "fresh" } },
      { method: "GET", url: "/rest/x", response: { ok: true } },
    ]).install();
    setOutputMode("llm"); // silence the login spinner
    const res = await apiFetch("/rest/x").finally(() => setOutputMode("human"));
    expect(res.status).toBe(200);
    expect(ff.requests.map(r => r.method)).toEqual(["GET", "POST", "GET"]);
    expect(ff.requests[1]!.json()).toEqual({ loginId: "u1", password: "p1" });
    expect(ff.requests[2]!.headers["authorization"]).toBe("Bearer fresh");
    expect(JSON.parse(readFileSync(cfg.sessionPath("t-dev"), "utf8")).token).toBe("fresh");
  });

  test("restore() puts the previous config back and drops the temp env", () => {
    cfg = withTempEnvConfig({ envs: { "t-gone": { url: "https://g.test" } } });
    expect(Config.getAllEnvs()["t-gone"]).toBeDefined();
    const { configPath } = cfg;
    cfg.restore();
    cfg = null;
    expect(Config.getAllEnvs()["t-gone"]).toBeUndefined();
    // the preload's seed config (single `test` env) is back
    expect(existsSync(configPath)).toBe(true);
    expect(Object.keys(Config.getAllEnvs())).toEqual(["test"]);
  });
});

describe("runCommand", () => {
  const good: CommandModule<{ n: number }, { n: number }> = {
    parseArgs: args => ({ n: Number(args[0] ?? 0) }),
    execute: args => ok({ n: args.n }),
  };

  test("ok envelope, exit 0, stdout is the envelope", async () => {
    const r = await runCommand(good, ["5"]);
    expect(r.exitCode).toBe(0);
    expect(r.envelope?.data).toEqual({ n: 5 });
    expect(JSON.parse(r.stdout)).toEqual(r.envelope!);
    expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
  });

  test("fail() and thrown CliError → ok:false, exit 1", async () => {
    const failing: CommandModule = { execute: () => fail("NOPE", "nope") };
    const throwing: CommandModule = {
      parseArgs: () => {
        throw new CliError("missing", { code: "MISSING_ARG" });
      },
      execute: () => ok(null),
    };
    for (const [mod, code] of [[failing, "NOPE"], [throwing, "MISSING_ARG"]] as const) {
      const r = await runCommand(mod);
      expect(r.exitCode).toBe(1);
      expect(r.envelope?.ok).toBe(false);
      expect(r.envelope?.error?.code).toBe(code);
    }
  });

  test("--env selects the env; unknown env → runner INVALID_ENV", async () => {
    cfg = withTempEnvConfig({ envs: { "t-env": { url: "https://e.test" } } });
    const probe: CommandModule = { execute: (_a, ctx) => ok({ env: ctx.env.name }) };
    const r = await runCommand(probe, [], { env: "t-env" });
    expect(r.envelope?.data).toEqual({ env: "t-env" });
    expect(Config.activeEnv.name).toBe("t-env"); // back to the default: the only configured env

    const bad = await runCommand(probe, [], { env: "no-such-env" });
    expect(bad.exitCode).toBe(1);
    expect(bad.envelope?.error?.code).toBe("INVALID_ENV");
    for (const proto of ["constructor", "toString", "__proto__"]) {
      const p = await runCommand(probe, [], { env: proto });
      expect(p.envelope?.error?.code).toBe("INVALID_ENV");
    }
  });

  test("--help is handled by the runner", async () => {
    const r = await runCommand(good, ["--help"], { helpResolver: async () => "HELP TEXT" });
    expect(r.envelope?.schema).toBe("belz.help");
    expect((r.envelope?.data as any).help).toBe("HELP TEXT");
  });

  test("process.exit inside a command is trapped", async () => {
    const exiting: CommandModule = {
      execute: () => {
        process.exit(3);
      },
    };
    const r = await runCommand(exiting);
    expect(r.exitCode).toBe(1);
    expect(r.envelope?.error?.message).toContain("process.exit(3)");
  });

  test("human mode captures presenter output", async () => {
    const human: CommandModule<unknown, string> = {
      execute: () => ok("x"),
      presentHuman: (_e, ui) => ui.text("hello human"),
    };
    const r = await runCommand(human, [], { llm: false });
    expect(r.stdout).toContain("hello human");
  });
});

describe("EnvelopeSchema", () => {
  const base = { schema: "t.cmd", version: "2.0", command: "c", meta: { durationMs: 0 } };
  test("accepts ok and error envelopes", () => {
    expect(EnvelopeSchema.safeParse({ ...base, ok: true, data: 1, error: null }).success).toBe(true);
    expect(
      EnvelopeSchema.safeParse({ ...base, ok: false, data: null, error: { code: "X", message: "m" } }).success
    ).toBe(true);
  });
  test("rejects inconsistent or malformed envelopes", () => {
    expect(EnvelopeSchema.safeParse({ ...base, ok: false, data: null, error: null }).success).toBe(false);
    expect(
      EnvelopeSchema.safeParse({ ...base, ok: true, data: null, error: { code: "X", message: "m" } }).success
    ).toBe(false);
    expect(
      EnvelopeSchema.safeParse({ ...base, ok: false, data: null, error: { code: "", message: "m" } }).success
    ).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...base, ok: true, data: 1, error: null, extra: 1 }).success).toBe(false);
  });
  test("rejects unstable names, versions, details and prefixes", () => {
    const bad = (patch: Record<string, unknown>) => EnvelopeSchema.safeParse({ ...base, ok: true, data: 1, error: null, ...patch }).success;
    expect(bad({ schema: "belz ad.runner" })).toBe(false);
    expect(bad({ schema: "result" })).toBe(false);
    expect(bad({ schema: "belz.migrate.status" })).toBe(false);
    expect(bad({ version: "1.0" })).toBe(false);
    expect(bad({ meta: {} })).toBe(false); // durationMs required
    const err = (e: Record<string, unknown>) =>
      EnvelopeSchema.safeParse({ ...base, ok: false, data: null, error: { code: "X", message: "m", ...e } }).success;
    expect(err({ details: "a string" })).toBe(false);
    expect(err({ details: ["x"] })).toBe(false);
    expect(err({ details: { text: "ok" } })).toBe(true);
    expect(err({ message: "Error: boom" })).toBe(false);
  });
});

describe("live-resources ledger", () => {
  let saved: string | undefined;
  afterEach(() => {
    if (saved === undefined) delete process.env.BELZ_LIVE_RESOURCES;
    else process.env.BELZ_LIVE_RESOURCES = saved;
  });

  test("register appends a row; markLiveResourceCleaned rewrites its last cell in place", () => {
    saved = process.env.BELZ_LIVE_RESOURCES;
    const path = join(scratchDir("ledger-"), "live-resources.md");
    writeFileSync(path, "| when | agent | kind | identifier | purpose | cleaned? |\n|---|---|---|---|---|---|\n");
    process.env.BELZ_LIVE_RESOURCES = path;
    expect(registerLiveResource({ kind: "method", identifier: "abc", purpose: "p | q", agent: "t" })).toBe(true);
    expect(registerLiveResource({ kind: "method", identifier: "def", purpose: "p2", agent: "t" })).toBe(true);
    expect(markLiveResourceCleaned("abc", "yes — soft-deleted")).toBe(true);
    expect(markLiveResourceCleaned("zzz", "yes")).toBe(false);
    const rows = readFileSync(path, "utf8").trim().split("\n").slice(2);
    expect(rows[0]).toMatch(/\| t \| method \| abc \| p \\\| q \| yes — soft-deleted \|$/);
    expect(rows[1]).toMatch(/\| def \| p2 \| no \|$/);
  });
});

describe("error and fixture helpers", () => {
  test("errorCode / thrownCliError / caughtCliError / rejectionCode", async () => {
    const { CliError } = await import("../src/command");
    const { caughtCliError, errorCode, rejectionCode, thrownCliError } = await import("../src/testing/errors");
    const boom = () => {
      throw new CliError("x", { code: "X_CODE" });
    };
    expect(errorCode(boom)).toBe("X_CODE");
    expect(thrownCliError(boom).message).toBe("x");
    expect(() => errorCode(() => 1)).toThrow("expected a CliError");
    expect(() => errorCode(() => { throw new TypeError("t"); })).toThrow("t");
    expect(await rejectionCode(Promise.reject(new CliError("y", { code: "Y" })))).toBe("Y");
    await expect(caughtCliError(Promise.resolve(1))).rejects.toThrow("expected a CliError");
  });

  test("jsonFixtures reads JSON from a dir, with an optional suffix", async () => {
    const { jsonFixtures } = await import("../src/testing/errors");
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const dir = mkdtempSync(join(tmpdir(), "belz-fixtures-"));
    writeFileSync(join(dir, "a.v2.json"), '{"n":1}');
    expect(jsonFixtures(dir)<{ n: number }>("a.v2.json").n).toBe(1);
    expect(jsonFixtures(dir, ".v2.json")<{ n: number }>("a")).toEqual({ n: 1 });
  });
});
