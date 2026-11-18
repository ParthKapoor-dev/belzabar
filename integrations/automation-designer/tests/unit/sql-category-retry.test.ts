// E12: `ad sql run` once failed SQL_NO_EXECUTABLE_CATEGORY on an env where the
// same statement ran 20 s later. The PUBLIC-category lookup is now retried
// once, a failed lookup is not cached, and the error says it was transient.
import { afterEach, describe, expect, test } from "bun:test";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { fetchExecutableCategory, resetExecutableCategoryCache } from "../../lib/sql/api";
import { buildSqlReadPayload } from "../../lib/sql/payload";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = cfg = null;
  resetExecutableCategoryCache();
});

const CATEGORY = /chain\/category/;
const PUBLICS = [{ id: 7, name: "Helpers", accessMode: "PUBLIC" }];

function setup(routes: Parameters<typeof fakeFetch>[0]) {
  resetExecutableCategoryCache({ retryDelayMs: 0 });
  cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
  ff = fakeFetch(routes).install();
}

const lookups = () => ff!.requests.filter((r) => CATEGORY.test(r.url)).length;

describe("fetchExecutableCategory", () => {
  test("a failed lookup is retried once", async () => {
    setup([
      { method: "GET", url: CATEGORY, once: true, response: respond({ status: 502, text: "bad gateway" }) },
      { method: "GET", url: CATEGORY, response: PUBLICS },
    ]);
    expect(await fetchExecutableCategory()).toEqual({ category: { id: 7, name: "Helpers" } });
    expect(lookups()).toBe(2);
  });

  test("an answer without a PUBLIC category is retried too", async () => {
    setup([
      { method: "GET", url: CATEGORY, once: true, response: [] },
      { method: "GET", url: CATEGORY, response: PUBLICS },
    ]);
    expect((await fetchExecutableCategory()).category?.id).toBe(7);
  });

  test("two failures: the reason, and nothing cached (the next statement looks again)", async () => {
    setup([
      { method: "GET", url: CATEGORY, once: true, response: respond({ status: 503, text: "down" }) },
      { method: "GET", url: CATEGORY, once: true, response: respond({ status: 503, text: "down" }) },
      { method: "GET", url: CATEGORY, response: PUBLICS },
    ]);
    const failed = await fetchExecutableCategory();
    expect(failed.category).toBeNull();
    expect(failed.failure).toContain("HTTP 503");
    expect(failed.failure).toContain("tried twice");
    expect((await fetchExecutableCategory()).category?.id).toBe(7);
    expect(lookups()).toBe(3);
  });

  test("a found category is cached", async () => {
    setup([{ method: "GET", url: CATEGORY, response: PUBLICS }]);
    await fetchExecutableCategory();
    await fetchExecutableCategory();
    expect(lookups()).toBe(1);
  });
});

test("SQL_NO_EXECUTABLE_CATEGORY names the failed lookup and says it is transient", () => {
  const operation = {
    id: 25,
    automationUserInputs: [{ id: 182, produces: "body", automationUserInputs: [{ id: 183, label: "SQLQuery", produces: "queryString" }] }],
  };
  const template = { jsonDefinition: JSON.stringify({ services: [{ automationApiId: 25, mappings: [] }] }) } as any;
  let err: any;
  try {
    buildSqlReadPayload({ template, operation: operation as any, dbAuthId: 1, query: "select 1", categoryLookupFailure: "the category lookup answered HTTP 503 (tried twice)" });
  } catch (e) {
    err = e;
  }
  expect(err.code).toBe("SQL_NO_EXECUTABLE_CATEGORY");
  expect(err.message).toContain("HTTP 503");
  expect(err.message).toContain("transient");
});
