// core/http: transport (timeout, DNS eviction), apiFetch (single-flight login,
// 401 retry incl. FormData, headers), error mapping, redaction.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { apiFetch } from "../src/http/api";
import { login, isTokenExpired, jwtExpiry } from "../src/http/auth";
import { httpRequest, singleFlight, createLimiter } from "../src/http/transport";
import { expectJson, expectOk, httpError, summarizeBody, expectFound } from "../src/http/errors";
import { redactSecrets, redactString, REDACTED } from "../src/http/redact";
import { CliError } from "../src/command";
import { setOutputMode } from "../src/ui";
import { fakeFetch, respond, type FakeFetch, type RecordedRequest } from "../src/testing/fake-fetch";
import { withTempEnvConfig, type TempEnvConfig } from "../src/testing/env-config";

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

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected a rejection");
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

  test("expectOk / expectFound / codePrefix", async () => {
    const r = new Response("x", { status: 200 });
    expect(await expectOk(r)).toBe(r);
    const e = await caught(expectOk(new Response("x", { status: 429 }), { codePrefix: "TW" }));
    expect(e.code).toBe("TW_429");
    const nf = await caught(expectOk(new Response("x", { status: 404 }), { codePrefix: "TW" }));
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
