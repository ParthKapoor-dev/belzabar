// core/http: transport (timeout, DNS eviction), apiFetch (single-flight login,
// 401 retry incl. FormData, headers), error mapping, redaction.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { apiFetch } from "../src/http/api";
import { login, isTokenExpired, jwtExpiry } from "../src/http/auth";
import {
  httpRequest,
  singleFlight,
  createLimiter,
  defaultTimeoutMs,
  resolveTimeoutMs,
  isConnectPhaseError,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_HTTP_WRITE_TIMEOUT_MS,
} from "../src/http/transport";
import { apiError, ensureApiOk, expectJson, httpError, readJsonOrNull, summarizeBody, expectFound } from "../src/http/errors";
import { redactSecrets, redactString, REDACTED } from "../src/http/redact";
import { CliError } from "../src/command";
import { setOutputMode } from "../src/ui";
import { fakeFetch, respond, type FakeFetch, type RecordedRequest } from "../src/testing/fake-fetch";
import { withTempEnvConfig, type TempEnvConfig } from "../src/testing/env-config";
import { caughtCliError as caught } from "../src/testing/errors";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  setOutputMode("human");
});

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.c2lnbmF0dXJlc2ln`;
}

describe("transport", () => {
  test("a hanging request fails with HTTP_TIMEOUT", async () => {
    ff = fakeFetch({ "GET https://slow.test/x": () => new Promise(() => {}) }).install();
    const err = await caught(httpRequest("https://slow.test/x", { timeoutMs: 30 }));
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("HTTP_TIMEOUT");
  });

  test("hanging fetch that honours the abort signal also maps to HTTP_TIMEOUT", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as any;
    try {
      const err = await caught(httpRequest("https://1.2.3.4/x", { timeoutMs: 20 }));
      expect(err.code).toBe("HTTP_TIMEOUT");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("default timeout: 60 s for GET/HEAD, 300 s for writes; env overrides; 0/none disable", () => {
    const saved = { a: process.env.BELZ_HTTP_TIMEOUT_MS, b: process.env.BELZ_HTTP_WRITE_TIMEOUT_MS };
    try {
      delete process.env.BELZ_HTTP_TIMEOUT_MS;
      delete process.env.BELZ_HTTP_WRITE_TIMEOUT_MS;
      expect(defaultTimeoutMs("GET")).toBe(DEFAULT_HTTP_TIMEOUT_MS);
      expect(defaultTimeoutMs("head")).toBe(60_000);
      expect(defaultTimeoutMs("POST")).toBe(DEFAULT_HTTP_WRITE_TIMEOUT_MS);
      expect(DEFAULT_HTTP_WRITE_TIMEOUT_MS).toBe(300_000);
      process.env.BELZ_HTTP_TIMEOUT_MS = "1234";
      expect(defaultTimeoutMs("GET")).toBe(1234);
      expect(defaultTimeoutMs("PUT")).toBe(1234); // one knob for both when only it is set
      process.env.BELZ_HTTP_WRITE_TIMEOUT_MS = "0";
      expect(defaultTimeoutMs("POST")).toBe(0);
      expect(defaultTimeoutMs("GET")).toBe(1234);
      expect(resolveTimeoutMs("none", "GET")).toBe(0);
      expect(resolveTimeoutMs(0, "POST")).toBe(0);
      expect(resolveTimeoutMs(50, "POST")).toBe(50);
    } finally {
      if (saved.a === undefined) delete process.env.BELZ_HTTP_TIMEOUT_MS;
      else process.env.BELZ_HTTP_TIMEOUT_MS = saved.a;
      if (saved.b === undefined) delete process.env.BELZ_HTTP_WRITE_TIMEOUT_MS;
      else process.env.BELZ_HTTP_WRITE_TIMEOUT_MS = saved.b;
    }
  });

  test("GET timeout: mayHaveCompleted false", async () => {
    ff = fakeFetch({ "GET https://slow.test/g": () => new Promise(() => {}) }).install();
    const err = await caught(httpRequest("https://slow.test/g", { timeoutMs: 20 }));
    expect(err.code).toBe("HTTP_TIMEOUT");
    expect((err.details as any).mayHaveCompleted).toBe(false);
    expect(err.message).not.toContain("may still complete");
  });

  test("non-GET timeout: never retried, says it may still complete server-side", async () => {
    ff = fakeFetch({ "POST https://slow.test/run": () => new Promise(() => {}) }).install();
    const err = await caught(httpRequest("https://slow.test/run", { method: "POST", body: "{}", timeoutMs: 20 }));
    expect(err.code).toBe("HTTP_TIMEOUT");
    expect(err.message).toContain("may still complete on the server");
    expect(err.details).toMatchObject({ mayHaveCompleted: true, retryable: false, method: "POST", timeoutMs: 20 });
    expect(ff.requests.length).toBe(1); // no hostname retry, no second attempt
  });

  test("apiFetch POST timeout is not retried (even with a 401-capable session)", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: "tok" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ "POST /chain/test": () => new Promise(() => {}) }).install();
    const err = await caught(apiFetch("/chain/test", { method: "POST", body: "{}", timeoutMs: 20 }));
    expect(err.code).toBe("HTTP_TIMEOUT");
    expect((err.details as any).mayHaveCompleted).toBe(true);
    expect(ff.calls("POST", "/chain/test").length).toBe(1);
  });

  test('timeoutMs: "none" waits past the default', async () => {
    const saved = process.env.BELZ_HTTP_WRITE_TIMEOUT_MS;
    process.env.BELZ_HTTP_WRITE_TIMEOUT_MS = "10";
    try {
      ff = fakeFetch({ "POST https://slow.test/long": async () => { await Bun.sleep(40); return { done: true }; } }).install();
      const res = await httpRequest("https://slow.test/long", { method: "POST", body: "{}", timeoutMs: "none" });
      expect(await res.json()).toEqual({ done: true });
      const err = await caught(httpRequest("https://slow.test/long", { method: "POST", body: "{}" }));
      expect(err.code).toBe("HTTP_TIMEOUT");
    } finally {
      if (saved === undefined) delete process.env.BELZ_HTTP_WRITE_TIMEOUT_MS;
      else process.env.BELZ_HTTP_WRITE_TIMEOUT_MS = saved;
    }
  });

  test("secret query values are redacted in timeout messages", async () => {
    ff = fakeFetch({ "GET https://slow.test/q": () => new Promise(() => {}) }).install();
    const err = await caught(httpRequest("https://slow.test/q?access_token=SEKRET&page=2", { timeoutMs: 10 }));
    expect(err.message).not.toContain("SEKRET");
    expect(err.message).toContain("page=2");
  });

  test("connect failure on the pinned IP → evict + one retry by hostname", async () => {
    ff = fakeFetch([
      {
        url: "https://lb.test/ping",
        response: (req: RecordedRequest) => {
          if (req.wireUrl.includes("127.0.0.2")) throw new TypeError("ECONNREFUSED");
          return { pong: true };
        },
      },
    ]).install();
    const res = await httpRequest("https://lb.test/ping");
    expect(await res.json()).toEqual({ pong: true });
    expect(ff.requests.map((r) => r.wireUrl)).toEqual(["https://127.0.0.2/ping", "https://lb.test/ping"]);
  });

  test("a network failure after the retry is HTTP_NETWORK_ERROR (not UNHANDLED)", async () => {
    ff = fakeFetch([{ url: /down\.test/, response: () => { throw new TypeError("ECONNREFUSED"); } }]).install();
    const err = await caught(httpRequest("https://down.test/x"));
    expect(err.code).toBe("HTTP_NETWORK_ERROR");
    expect(ff.requests.length).toBe(2);
  });

  test("POST + ECONNRESET on the pinned IP → 1 request, mayHaveCompleted, never re-sent", async () => {
    ff = fakeFetch([
      {
        url: "https://lb.test/chain/run",
        method: "POST",
        response: () => {
          throw Object.assign(new Error("socket connection was closed unexpectedly"), { code: "ECONNRESET" });
        },
      },
    ]).install();
    const err = await caught(httpRequest("https://lb.test/chain/run", { method: "POST", body: "{}" }));
    expect(err.code).toBe("HTTP_NETWORK_ERROR");
    expect(err.details).toMatchObject({ method: "POST", connectPhase: false, mayHaveCompleted: true, retryable: false });
    expect(err.message).toContain("may have reached the server");
    expect(ff.requests.length).toBe(1);
  });

  test("POST + connection refused on the pinned IP → safe hostname retry", async () => {
    ff = fakeFetch([
      {
        url: "https://lb.test/chain/save",
        method: "POST",
        response: (req: RecordedRequest) => {
          if (req.wireUrl.includes("127.0.0.2"))
            throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
          return { saved: true };
        },
      },
    ]).install();
    const res = await httpRequest("https://lb.test/chain/save", { method: "POST", body: "{}" });
    expect(await res.json()).toEqual({ saved: true });
    expect(ff.requests.length).toBe(2);
  });

  test("GET + ECONNRESET on the pinned IP is retried by hostname (idempotent)", async () => {
    ff = fakeFetch([
      {
        url: "https://lb.test/read",
        response: (req: RecordedRequest) => {
          if (req.wireUrl.includes("127.0.0.2")) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
          return { ok: 1 };
        },
      },
    ]).install();
    const res = await httpRequest("https://lb.test/read");
    expect(await res.json()).toEqual({ ok: 1 });
    expect(ff.requests.length).toBe(2);
  });

  test("isConnectPhaseError classifies connect vs mid-flight failures", () => {
    expect(isConnectPhaseError(new TypeError("ECONNREFUSED"))).toBe(true);
    expect(isConnectPhaseError(Object.assign(new Error("x"), { code: "ConnectionRefused" }))).toBe(true);
    expect(isConnectPhaseError(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(true);
    expect(isConnectPhaseError(Object.assign(new Error("x"), { code: "EHOSTUNREACH" }))).toBe(true);
    expect(isConnectPhaseError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(isConnectPhaseError(new Error("The socket connection was closed unexpectedly"))).toBe(false);
  });

  test("a body that stalls after the headers fails with HTTP_TIMEOUT instead of hanging", async () => {
    const enc = new TextEncoder();
    ff = fakeFetch({
      "GET https://slow.test/body": () =>
        new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"partial":')); } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }).install();
    const res = await httpRequest("https://slow.test/body", { timeoutMs: 30 });
    expect(res.status).toBe(200);
    const err = await caught(res.text());
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("HTTP_TIMEOUT");
    expect(err.details).toMatchObject({ phase: "body", mayHaveCompleted: false });
  });

  test("a body that keeps flowing is read whole; no deadline when timeoutMs is none", async () => {
    const enc = new TextEncoder();
    const slowBody = () =>
      new Response(
        new ReadableStream({
          async start(c) {
            for (const part of ['{"a"', ":", "1}"]) { await Bun.sleep(15); c.enqueue(enc.encode(part)); }
            c.close();
          },
        }),
        { status: 200 },
      );
    ff = fakeFetch({ "GET https://slow.test/flow": slowBody, "POST https://slow.test/stream": slowBody }).install();
    expect(await (await httpRequest("https://slow.test/flow", { timeoutMs: 30 })).json()).toEqual({ a: 1 });
    const res = await httpRequest("https://slow.test/stream", { method: "POST", body: "{}", timeoutMs: "none" });
    expect(await res.text()).toBe('{"a":1}');
  });

  test("singleFlight shares one in-flight promise per key", async () => {
    const sf = singleFlight<number>();
    let calls = 0;
    const fn = async () => { calls++; await Bun.sleep(5); return calls; };
    const [a, b, c] = await Promise.all([sf("k", fn), sf("k", fn), sf("other", fn)]);
    expect(a).toBe(b);
    expect(calls).toBe(2);
    await sf("k", fn);
    expect(calls).toBe(3);
  });

  test("createLimiter caps concurrency", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limit(async () => { active++; peak = Math.max(peak, active); await Bun.sleep(3); active--; }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("apiFetch", () => {
  test("GET sends no Content-Type; POST JSON does", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ "GET /a": {}, "POST /b": {} }).install();
    await apiFetch("/a");
    await apiFetch("/b", { method: "POST", body: "{}" });
    expect(ff.requests[0]!.headers["content-type"]).toBeUndefined();
    expect(ff.requests[1]!.headers["content-type"]).toBe("application/json");
  });

  test("Expertly-Auth-Token: true is replaced by the session token", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: "tok" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ "POST /t": {} }).install();
    await apiFetch("/t", { method: "POST", headers: { "Expertly-Auth-Token": "true" }, body: new FormData() });
    expect(ff.requests[0]!.headers["expertly-auth-token"]).toBe("tok");
    expect(ff.requests[0]!.headers["content-type"] ?? "").not.toContain("application/json");
  });

  test("concurrent calls with no session log in once (single-flight)", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: null } }, activeEnv: "t-dev" });
    setOutputMode("llm");
    ff = fakeFetch([
      { method: "POST", url: "/do/login", response: async () => { await Bun.sleep(10); return { token: "one" }; } },
      { method: "GET", url: "/r/*", response: {} },
    ]).install();
    await Promise.all([1, 2, 3, 4, 5].map((i) => apiFetch(`/r/${i}`)));
    expect(ff.calls("POST", "/do/login").length).toBe(1);
    expect(ff.calls("GET").every((r) => r.headers["authorization"] === "Bearer one")).toBe(true);
  });

  test("login uses the read timeout and a login-specific message", async () => {
    const saved = { a: process.env.BELZ_HTTP_TIMEOUT_MS, b: process.env.BELZ_HTTP_WRITE_TIMEOUT_MS };
    process.env.BELZ_HTTP_TIMEOUT_MS = "25";
    process.env.BELZ_HTTP_WRITE_TIMEOUT_MS = "600000";
    try {
      cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", user: "u", password: "p" } }, activeEnv: "t-dev" });
      ff = fakeFetch([{ method: "POST", url: "/do/login", response: () => new Promise(() => {}) }]).install();
      const started = Date.now();
      const err = await caught(login());
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(err.code).toBe("HTTP_TIMEOUT");
      expect(err.message).toContain("Login to t-dev timed out");
      expect(err.message).not.toContain("may still complete");
      expect(err.details).toMatchObject({ mayHaveCompleted: false });
    } finally {
      if (saved.a === undefined) delete process.env.BELZ_HTTP_TIMEOUT_MS;
      else process.env.BELZ_HTTP_TIMEOUT_MS = saved.a;
      if (saved.b === undefined) delete process.env.BELZ_HTTP_WRITE_TIMEOUT_MS;
      else process.env.BELZ_HTTP_WRITE_TIMEOUT_MS = saved.b;
    }
  });

  test("concurrent 401s share one re-login", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: "stale" } }, activeEnv: "t-dev" });
    setOutputMode("llm");
    ff = fakeFetch([
      { method: "POST", url: "/do/login", response: async () => { await Bun.sleep(10); return { token: "fresh" }; } },
      {
        method: "GET",
        url: "/r/*",
        response: (req: RecordedRequest) => (req.headers["authorization"] === "Bearer fresh" ? { ok: 1 } : respond({ status: 401, text: "" })),
      },
    ]).install();
    const results = await Promise.all([1, 2, 3].map((i) => apiFetch(`/r/${i}`)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(ff.calls("POST", "/do/login").length).toBe(1);
  });

  test("401 retry re-sends a FormData body", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: "stale" } }, activeEnv: "t-dev" });
    setOutputMode("llm");
    ff = fakeFetch([
      { method: "POST", url: "/upload", response: respond({ status: 401 }), once: true },
      { method: "POST", url: "/do/login", response: { token: "fresh" } },
      { method: "POST", url: "/upload", response: { ok: true } },
    ]).install();
    const fd = new FormData();
    fd.append("body", '{"a":1}');
    const res = await apiFetch("/upload", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const uploads = ff.calls("POST", "/upload");
    expect(uploads.length).toBe(2);
    expect(uploads[1]!.body).toBe(JSON.stringify([["body", '{"a":1}']]));
    expect(uploads[1]!.headers["authorization"]).toBe("Bearer fresh");
  });

  test("a second 401 after a successful re-login fails AUTH_FAILED (no loop)", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: "stale" } }, activeEnv: "t-dev" });
    setOutputMode("llm");
    ff = fakeFetch([
      { method: "POST", url: "/do/login", response: { token: "fresh" } },
      { method: "GET", url: "/forbidden", response: respond({ status: 401, text: "nope" }) },
    ]).install();
    const err = await caught(apiFetch("/forbidden?token=QS"));
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.message).toContain("even after re-login");
    expect(err.message).not.toContain("QS");
    expect(ff.calls("POST", "/do/login").length).toBe(1);
    expect(ff.calls("GET", "/forbidden").length).toBe(2);
  });

  test("401 refresh writes nothing to stdout/stderr in --llm mode", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: "stale" } }, activeEnv: "t-dev" });
    setOutputMode("llm");
    ff = fakeFetch([
      { method: "GET", url: "/x", response: respond({ status: 401 }), once: true },
      { method: "POST", url: "/do/login", response: { token: "fresh" } },
      { method: "GET", url: "/x", response: { ok: true } },
    ]).install();
    const written: string[] = [];
    const origErrWrite = process.stderr.write.bind(process.stderr);
    const origOutWrite = process.stdout.write.bind(process.stdout);
    const origError = console.error;
    const origLog = console.log;
    const origVerbose = process.env.BELZ_VERBOSE;
    delete process.env.BELZ_VERBOSE;
    process.stderr.write = ((c: unknown) => { written.push(String(c)); return true; }) as typeof process.stderr.write;
    process.stdout.write = ((c: unknown) => { written.push(String(c)); return true; }) as typeof process.stdout.write;
    console.error = (...a: unknown[]) => { written.push(a.join(" ")); };
    console.log = (...a: unknown[]) => { written.push(a.join(" ")); };
    try {
      const res = await apiFetch("/x");
      expect(res.status).toBe(200);
    } finally {
      process.stderr.write = origErrWrite;
      process.stdout.write = origOutWrite;
      console.error = origError;
      console.log = origLog;
      if (origVerbose !== undefined) process.env.BELZ_VERBOSE = origVerbose;
    }
    expect(written).toEqual([]);
  });

  test("login failure → AUTH_FAILED with the HTML body reduced to its title", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: null } }, activeEnv: "t-dev" });
    setOutputMode("llm");
    ff = fakeFetch({
      "POST /do/login": respond({ status: 403, headers: { "content-type": "text/html" }, text: "<html><head><title>Forbidden</title></head><body>" + "x".repeat(5000) + "</body></html>" }),
    }).install();
    const err = await caught(login());
    expect(err.code).toBe("AUTH_FAILED");
    expect(err.message).toContain("HTML page: Forbidden");
    expect(err.message.length).toBeLessThan(200);
  });

  test("missing credentials → AUTH_MISSING_CREDENTIALS", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: null, user: "" } }, activeEnv: "t-dev" });
    ff = fakeFetch({}).install();
    const err = await caught(apiFetch("/x"));
    expect(err.code).toBe("AUTH_MISSING_CREDENTIALS");
    expect(err.message).not.toContain(".env");
  });

  test("session files are written 0600", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: null } }, activeEnv: "t-dev" });
    setOutputMode("llm");
    ff = fakeFetch({ "POST /do/login": { token: "t1" } }).install();
    await login();
    const p = cfg.sessionPath("t-dev");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(p, "utf8")).token).toBe("t1");
  });
});

describe("error mapping", () => {
  test("404 → NOT_FOUND, 5xx → HTTP_<status>, HTML stripped to title", async () => {
    const e404 = await httpError(new Response("nope", { status: 404 }), { path: "/x" });
    expect(e404.code).toBe("NOT_FOUND");
    const html = `<!DOCTYPE html><html><head><title>Error 502 &amp; stuff</title></head><body>${"y".repeat(90_000)}</body></html>`;
    const e502 = await httpError(new Response(html, { status: 502, statusText: "Bad Gateway" }), { path: "/x", method: "get" });
    expect(e502.code).toBe("HTTP_502");
    expect(e502.message).toBe("HTTP 502 Bad Gateway on GET /x: HTML page: Error 502 & stuff");
    expect((e502.details as any).body).toBe("HTML page: Error 502 & stuff");
  });

  test("long bodies are truncated and redacted", () => {
    const s = summarizeBody(`{"token":"abc","msg":"${"z".repeat(2000)}"}`);
    expect(s.length).toBeLessThan(560);
    expect(s).not.toContain("abc");
  });

  test("expectJson: 200 with empty or null body is not-found", async () => {
    for (const body of ["", "null", "  "]) {
      const err = await caught(expectJson(new Response(body, { status: 200 }), { path: "/c/u", notFoundCode: "METHOD_NOT_FOUND" }));
      expect(err.code).toBe("METHOD_NOT_FOUND");
    }
    expect(await expectJson<{ a: number }>(new Response('{"a":1}'))).toEqual({ a: 1 });
    const bad = await caught(expectJson(new Response("<html>", { status: 200 })));
    expect(bad.code).toBe("HTTP_BAD_JSON");
  });

  test("httpError codePrefix / expectFound", async () => {
    const e = await httpError(new Response("x", { status: 429 }), { codePrefix: "TW" });
    expect(e.code).toBe("TW_429");
    const nf = await httpError(new Response("x", { status: 404 }), { codePrefix: "TW" });
    expect(nf.code).toBe("TW_NOT_FOUND");
    expect(() => expectFound(null, { notFoundCode: "X_NOT_FOUND" })).toThrow(CliError);
    expect(expectFound(0)).toBe(0);
  });
});

describe("redaction", () => {
  const token = jwt({ sub: "u", exp: 1 });

  test("header-like keys and JWTs are redacted deep, input untouched", () => {
    const input = {
      headers: { Authorization: `Bearer ${token}`, "Expertly-Auth-Token": token, Accept: "json" },
      debugResult: { services: [{ request: `curl -H 'Authorization: Bearer ${token}'` }] },
      password: "hunter2",
      nested: [{ cookie: "tw-auth=abc" }],
      note: `token is ${token}`,
      count: 3,
    };
    const out = redactSecrets(input) as any;
    const text = JSON.stringify(out);
    expect(text).not.toContain(token);
    expect(text).not.toContain("hunter2");
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers["Expertly-Auth-Token"]).toBe(REDACTED);
    expect(out.headers.Accept).toBe("json");
    expect(out.count).toBe(3);
    expect(input.password).toBe("hunter2");
  });

  test("string forms: Bearer/Basic, header lines, cookies, JSON password fields", () => {
    const s = redactString(
      `Authorization: Basic dTpw\nExpertly-Auth-Token: ${token}\nCookie: tw-auth=sekret; JSESSIONID.abc=zzz\n{"password":"pw1","user":"u"}`,
    );
    expect(s).not.toMatch(/dTpw|sekret|zzz|pw1/);
    expect(s).not.toContain(token);
    expect(s).toContain('"user":"u"');
  });

  test("query-string and form-encoded secrets", () => {
    const s = redactString(
      "GET https://h.test/a?token=T1&page=2 | /b?access_token=T2#x | j_username=bob&j_password=T3 | " +
        "?apiKey=T4&api_key=T5&api-key=T6&keyword=hello | ?password=T7 | ?client_secret=T8&refresh_token=T9",
    );
    expect(s).not.toMatch(/T[1-9]/);
    expect(s).toContain("page=2");
    expect(s).toContain("j_username=bob");
    expect(s).toContain("keyword=hello");
    expect(redactSecrets({ url: "https://h.test/x?crumb=C1" }).url).not.toContain("C1");
  });

  test("httpError / not-found messages redact secret query values in the path", async () => {
    const e1 = await httpError(new Response("boom", { status: 500 }), { path: "/x?token=SEK" });
    expect(e1.message).not.toContain("SEK");
    expect(JSON.stringify(e1.details)).not.toContain("SEK");
    const e2 = await caught(expectJson(new Response("", { status: 200 }), { path: "/y?apiKey=SEK2" }));
    expect(e2.message).not.toContain("SEK2");
    expect(JSON.stringify(e2.details)).not.toContain("SEK2");
  });

  test("XML echo of the bearer token (V2 test response)", () => {
    const xml = `<HashMap><Authorization>Bearer ${token}</Authorization><x>1</x></HashMap>`;
    const s = redactString(xml);
    expect(s).not.toContain(token);
    expect(s).toContain("<x>1</x>");
  });
});

describe("jwt helpers", () => {
  test("jwtExpiry / isTokenExpired", () => {
    const now = Date.now();
    const fresh = jwt({ exp: Math.floor(now / 1000) + 3600 });
    const old = jwt({ exp: Math.floor(now / 1000) - 10 });
    expect(jwtExpiry(fresh)).toBeGreaterThan(0);
    expect(isTokenExpired(fresh)).toBe(false);
    expect(isTokenExpired(old)).toBe(true);
    expect(isTokenExpired("not-a-jwt")).toBe(false);
  });
});

describe("apiError / ensureApiOk / readJsonOrNull badJson", () => {
  test("default message, code by status, details {path, status, body}", async () => {
    const res = new Response(JSON.stringify({ message: "stale" }), { status: 409, statusText: "Conflict" });
    const e = await apiError(res, { path: "/p", code: (s) => (s === 409 ? "X_CONFLICT" : "X_API_ERROR") });
    expect(e.code).toBe("X_CONFLICT");
    expect(e.message).toBe("409 Conflict on /p");
    expect(e.details).toEqual({ path: "/p", status: 409, body: { message: "stale" } });
  });

  test("custom message; no path → no details.path; ok responses pass", async () => {
    const e = await caught(ensureApiOk(new Response("<html><title>Down</title></html>", { status: 503 }), { code: "X", message: (r) => `failed (${r.status})` }));
    expect(e.message).toBe("failed (503)");
    expect(e.details).toEqual({ status: 503, body: "HTML page: Down" });
    await ensureApiOk(new Response("{}", { status: 200 }), { code: "X" });
  });

  test("badJson overrides HTTP_BAD_JSON", async () => {
    const e = await caught(readJsonOrNull(new Response("<html>", { status: 200 }), { badJson: (text) => new CliError(`bad: ${text}`, { code: "X_BAD" }) }));
    expect(e.code).toBe("X_BAD");
    expect(await readJsonOrNull(new Response(" null ", { status: 200 }), { badJson: () => new CliError("no") })).toBeNull();
  });
});
