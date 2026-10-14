// PD API errors carry a summarised body (HTML → <title>, truncated, redacted).
import { afterEach, expect, test } from "bun:test";
import { caughtCliError, fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { fetchPage, publishPage, savePageFull, savePagePartial } from "../../lib/api/client";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = null;
  cfg = null;
});

test("a 502 HTML page becomes 'HTML page: <title>' in error.details.body", async () => {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
  ff = fakeFetch([
    {
      url: /\/rest\/api\/pagedesigner\/pages\//,
      response: respond({ status: 502, headers: { "content-type": "text/html" }, text: `<html><title>Bad Gateway</title>${"x".repeat(20_000)}</html>` }),
    },
  ]).install();
  const err = await caughtCliError(fetchPage("abc"));
  expect(err.code).toBe("PD_API_ERROR");
  expect((err.details as any).body).toBe("HTML page: Bad Gateway");
});

test("a 200 with an HTML (SSO) body is PD_API_ERROR, and an empty 200 is null — never a raw SyntaxError", async () => {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
  ff = fakeFetch([
    { url: /pages\/html1/, response: respond({ status: 200, headers: { "content-type": "text/html" }, text: "<html><title>Sign in</title></html>" }) },
    { url: /pages\/empty1/, response: respond({ status: 200, text: "" }) },
  ]).install();
  const err = await caughtCliError(fetchPage("html1"));
  expect(err.code).toBe("PD_API_ERROR");
  expect((err.details as any).body).toBe("HTML page: Sign in");
  expect(await fetchPage("empty1")).toBeNull();
});

test("a PD save/publish whose answer stalls keeps HTTP_TIMEOUT (mayHaveCompleted); an empty answer is {}", async () => {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
  const enc = new TextEncoder();
  const stall = () => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"versionId":')); } }), { status: 200, headers: { "content-type": "application/json" } });
  ff = fakeFetch([
    { method: "PUT", url: /pages\/stall1$/, response: stall },
    { method: "POST", url: /pages\/stall1\/publish/, response: stall },
    { method: "PUT", url: /pages\/empty1$/, response: respond({ status: 200, text: "" }) },
  ]).install();
  const prev = process.env.WI_IMPL_HTTP_WRITE_TIMEOUT_MS;
  process.env.WI_IMPL_HTTP_WRITE_TIMEOUT_MS = "30";
  try {
    for (const p of [savePageFull("stall1", "DRAFT", "{}"), savePagePartial("stall1", "DRAFT", []), publishPage("stall1")]) {
      const err = await caughtCliError(p);
      expect(err.code).toBe("HTTP_TIMEOUT");
      expect(err.message).toContain("was accepted (HTTP 200)");
      expect((err.details as any).mayHaveCompleted).toBe(true);
    }
    expect(await savePageFull("empty1", "DRAFT", "{}")).toEqual({ newVersionId: null, configuration: null, raw: {} });
  } finally {
    if (prev === undefined) delete process.env.WI_IMPL_HTTP_WRITE_TIMEOUT_MS;
    else process.env.WI_IMPL_HTTP_WRITE_TIMEOUT_MS = prev;
  }
});
