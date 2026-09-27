// Tests for @belzabar/core/testing itself: fakeFetch, withTempEnvConfig,
// runCommand, EnvelopeSchema. Also exercises apiFetch/login end-to-end
// (IPv4 pinning + session + 401 re-login) with no network.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { apiFetch } from "../src/api";
import { CliError, fail, ok, type CommandModule } from "../src/command";
import { Config } from "../src/config";
import { EnvelopeSchema } from "../src/envelope";
import { setOutputMode } from "../src/ui";
import {
  fakeFetch,
  fixture,
  respond,
  runCommand,
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

  test("restore() removes the temp config and env", () => {
    cfg = withTempEnvConfig({ envs: { "t-gone": { url: "https://g.test" } } });
    expect(Config.getAllEnvs()["t-gone"]).toBeDefined();
    const { configPath } = cfg;
    cfg.restore();
    cfg = null;
    expect(Config.getAllEnvs()["t-gone"]).toBeUndefined();
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("runCommand", () => {
  const good: CommandModule<{ n: number }, { n: number }> = {
    schema: "t.good",
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
    expect(Config.activeEnv.name).toBe("nsm-dev"); // restored

    const bad = await runCommand(probe, [], { env: "no-such-env" });
    expect(bad.exitCode).toBe(1);
    expect(bad.envelope?.error?.code).toBe("INVALID_ENV");
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
  const base = { schema: "s", version: "2.0", command: "c", meta: {} };
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
});
