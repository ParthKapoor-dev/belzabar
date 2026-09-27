// AD-11 / F10: an unknown uuid is answered with 200 + empty body → METHOD_NOT_FOUND.
// ad-validation §1.7: debug-mode test responses echo the bearer token → redacted.
import { afterEach, describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import * as v1 from "../../lib/api/v1";
import * as v2 from "../../lib/api/v2";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

const UUID = "0000000000000000000000000000dead";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiZXhwIjo5OTk5OTk5OTk5fQ.c2lnbmF0dXJlLXNpZw";

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected rejection");
}

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test", token: JWT } }, activeEnv: "t-dev" });
  ff = fakeFetch(routes).install();
}

describe("chain fetch not-found", () => {
  for (const body of ["", "null"]) {
    test(`v1 + v2 fetchMethod/fetchRawMethod: 200 with ${JSON.stringify(body)} → METHOD_NOT_FOUND`, async () => {
      setup([{ url: /\/rest\/api\/automation\/chain\//, response: respond({ status: 200, text: body }) }]);
      for (const p of [v1.fetchMethod(UUID), v1.fetchRawMethod(UUID), v2.fetchMethod(UUID), v2.fetchRawMethod(UUID)]) {
        const e = await caught(p);
        expect(e).toBeInstanceOf(CliError);
        expect(e.code).toBe("METHOD_NOT_FOUND");
        expect(e.message).toContain(UUID);
      }
    });
  }

  test("404 → METHOD_NOT_FOUND; 500 HTML → AD_API_ERROR with the title only", async () => {
    setup([
      { url: `/rest/api/automation/chain/${UUID}`, response: respond({ status: 404, text: "Chain Not Found" }) },
      {
        url: /chain\/v2\//,
        response: respond({ status: 500, headers: { "content-type": "text/html" }, text: `<html><title>Boom</title>${"z".repeat(50_000)}</html>` }),
      },
    ]);
    expect((await caught(v1.fetchMethod(UUID))).code).toBe("METHOD_NOT_FOUND");
    const e = await caught(v2.fetchMethod(UUID));
    expect(e.code).toBe("AD_API_ERROR");
    expect((e.details as any).body).toBe("HTML page: Boom");
  });
});

describe("test responses are redacted", () => {
  const echo = {
    executionStatus: { failed: false },
    debugResult: {
      requestHeaders: { Authorization: `Bearer ${JWT}`, "Expertly-Auth-Token": JWT, Accept: "*/*" },
      log: `curl -H "Authorization: Bearer ${JWT}"`,
    },
    token: "an-output-named-token",
  };

  test("testMethodMultipart scrubs the echoed token but keeps data fields", async () => {
    setup([{ method: "POST", url: "/rest/api/automation/chain/test", response: echo }]);
    const res = await v1.testMethodMultipart(new FormData());
    const text = await res.text();
    expect(text).not.toContain(JWT);
    const json = JSON.parse(text);
    expect(json.debugResult.requestHeaders.Accept).toBe("*/*");
    expect(json.token).toBe("an-output-named-token");
    // the request itself still carried the real token
    expect(ff!.requests[0]!.headers["expertly-auth-token"]).toBe(JWT);
  });

  test("v2 testExecute scrubs the XML echo", async () => {
    setup([
      {
        method: "POST",
        url: /test\/execute\//,
        response: respond({ text: `<HashMap><executionStatus><failed>false</failed></executionStatus><auth>Bearer ${JWT}</auth></HashMap>` }),
      },
    ]);
    const r = await v2.testExecute(UUID, {});
    expect(r.rawXml).not.toContain(JWT);
    expect(JSON.stringify(r.outputs)).not.toContain(JWT);
  });
});
