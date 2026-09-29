// Teamwork adapter over core/http: cookie session, single-flight re-login,
// 429 backoff, bounded concurrency, coded errors.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR, CliError, getOutputMode, setOutputMode } from "@belzabar/core";
import { caughtCliError as caught, fakeFetch, type FakeFetch, type RecordedRequest, respond, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
import { fetchTask, searchTasks, setTeamworkBackoffForTesting, teamworkFetch, TEAMWORK_CONCURRENCY } from "../../lib/api";
import { saveTeamworkSession } from "../../lib/auth";

const SESSION = join(BELZ_CONFIG_DIR, "sessions", "teamwork.json");
const LOGIN = "https://tw.example.test/launchpad/v1/login.json";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
const origStderr = process.stderr.write.bind(process.stderr);
const origConsoleError = console.error;
const origMode = getOutputMode();
let notices: string[] = [];

beforeEach(() => {
  rmSync(SESSION, { force: true });
  notices = [];
  (process.stderr as any).write = () => true;
  console.error = (...a: unknown[]) => { notices.push(a.map(String).join(" ")); }; // lifecycle.notice → printErr
});
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  rmSync(SESSION, { force: true });
  setTeamworkBackoffForTesting(null);
  (process.stderr as any).write = origStderr;
  console.error = origConsoleError;
  setOutputMode(origMode);
});

function loginOk(cookie = "fresh") {
  return respond({ status: 200, headers: { "set-cookie": `tw-auth=${cookie}; Path=/; HttpOnly` }, json: {} });
}

describe("teamwork adapter", () => {
  test("logs in with the plain-encoded password, stores the cookie 0600, sends it", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "pw plain", passwordEncoding: "plain" } });
    ff = fakeFetch([
      { method: "POST", url: LOGIN, response: loginOk("c1") },
      { method: "GET", url: "/projects/api/v3/x.json", response: { ok: 1 } },
    ]).install();
    const res = await teamworkFetch("/projects/api/v3/x.json");
    expect(res.status).toBe(200);
    expect(ff.requests[0]!.json()).toEqual({ email: "me@x.test", password: "pw plain", rememberMe: true });
    expect(ff.requests[1]!.headers["cookie"]).toBe("tw-auth=c1");
    expect(JSON.parse(readFileSync(SESSION, "utf8"))).toEqual({ twAuth: "c1" });
    expect(statSync(SESSION).mode & 0o777).toBe(0o600);
  });

  test("legacy base64 password still decodes", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: btoa("old") } });
    ff = fakeFetch([
      { method: "POST", url: LOGIN, response: loginOk() },
      { method: "GET", url: "/y", response: {} },
    ]).install();
    await teamworkFetch("/y");
    expect(ff.requests[0]!.json().password).toBe("old");
  });

  test("concurrent 401s share one re-login", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "p", passwordEncoding: "plain" } });
    await saveTeamworkSession({ twAuth: "stale" });
    ff = fakeFetch([
      { method: "POST", url: LOGIN, response: async () => { await Bun.sleep(10); return loginOk("fresh"); } },
      {
        method: "GET",
        url: "/t/*",
        response: (req: RecordedRequest) => (req.headers["cookie"] === "tw-auth=fresh" ? { ok: 1 } : respond({ status: 401 })),
      },
    ]).install();
    const res = await Promise.all([1, 2, 3, 4].map((i) => teamworkFetch(`/t/${i}`)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(ff.calls("POST").length).toBe(1);
  });

  test("429 → backoff (Retry-After) then success", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "p", passwordEncoding: "plain" } });
    await saveTeamworkSession({ twAuth: "ok" });
    const waits: number[] = [];
    setTeamworkBackoffForTesting(async (ms) => { waits.push(ms); });
    ff = fakeFetch([
      { method: "GET", url: "/z", response: respond({ status: 429, headers: { "retry-after": "2" } }), once: true },
      { method: "GET", url: "/z", response: { ok: 1 } },
    ]).install();
    const r = await teamworkFetch("/z");
    expect(r.status).toBe(200);
    expect(waits).toEqual([2000]);
  });

  test("at most TEAMWORK_CONCURRENCY requests in flight", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "p", passwordEncoding: "plain" } });
    await saveTeamworkSession({ twAuth: "ok" });
    let active = 0;
    let peak = 0;
    ff = fakeFetch([
      {
        url: "/c/*",
        response: async () => { active++; peak = Math.max(peak, active); await Bun.sleep(5); active--; return {}; },
      },
    ]).install();
    await Promise.all(Array.from({ length: 20 }, (_, i) => teamworkFetch(`/c/${i}`)));
    expect(peak).toBe(TEAMWORK_CONCURRENCY);
  });

  test("404 → TW_NOT_FOUND; 5xx HTML → TW_HTTP_502 with only the page title", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "p", passwordEncoding: "plain" } });
    await saveTeamworkSession({ twAuth: "ok" });
    ff = fakeFetch([
      { url: /\/tasks\/1\.json/, response: respond({ status: 404, json: { errors: [] } }) },
      {
        url: /\/tasks\.json/,
        response: respond({ status: 502, headers: { "content-type": "text/html" }, text: "<html><title>Bad Gateway</title><body>" + "b".repeat(9000) + "</body></html>" }),
      },
    ]).install();
    const nf = await caught(fetchTask(1));
    expect(nf.code).toBe("TW_NOT_FOUND");
    const e = await caught(searchTasks("q"));
    expect(e.code).toBe("TW_HTTP_502");
    expect(e.message).toBe("Teamwork search failed (HTTP 502): HTML page: Bad Gateway");
  });

  test("missing credentials → TW_AUTH_MISSING_CREDENTIALS", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test" } });
    ff = fakeFetch([]).install();
    const e = await caught(teamworkFetch("/x"));
    expect(e.code).toBe("TW_AUTH_MISSING_CREDENTIALS");
  });

  test("no Teamwork site configured → TW_CONFIG_MISSING (there is no built-in site), nothing sent", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { email: "me@x.test", password: "p", passwordEncoding: "plain" } });
    ff = fakeFetch([]).install();
    const e = await caught(teamworkFetch("/x"));
    expect(e.code).toBe("TW_CONFIG_MISSING");
    expect(e.message).toContain("BELZ_TEAMWORK_URL");
    expect(ff.requests).toHaveLength(0);
  });

  test("login failure → TW_AUTH_FAILED without echoing the password", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "s3cret", passwordEncoding: "plain" } });
    ff = fakeFetch([{ method: "POST", url: LOGIN, response: respond({ status: 401, json: { password: "s3cret", error: "bad" } }) }]).install();
    const e = await caught(teamworkFetch("/x"));
    expect(e.code).toBe("TW_AUTH_FAILED");
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain("s3cret");
  });

  test("auth notices go through lifecycle.notice: shown in human mode, silent with --llm", async () => {
    cfg = withTempEnvConfig({ envs: {}, teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "p", passwordEncoding: "plain" } });
    ff = fakeFetch([
      { method: "POST", url: LOGIN, response: loginOk() },
      { method: "GET", url: "/n", response: {} },
    ]).install();
    setOutputMode("human");
    await teamworkFetch("/n");
    expect(notices.some((n) => n.includes("[Teamwork] Authenticating as me@x.test"))).toBe(true);

    rmSync(SESSION, { force: true });
    notices = [];
    setOutputMode("llm");
    await teamworkFetch("/n");
    expect(ff.calls("POST").length).toBe(2);
    expect(notices).toEqual([]);
  });
});
