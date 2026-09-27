// PD API errors carry a summarised body (HTML → <title>, truncated, redacted).
import { afterEach, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { fetchPage } from "../../lib/api/client";

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
  let err: CliError | null = null;
  try {
    await fetchPage("abc");
  } catch (e) {
    err = e as CliError;
  }
  expect(err?.code).toBe("PD_API_ERROR");
  expect((err?.details as any).body).toBe("HTML page: Bad Gateway");
});
