// E11: a stopped env answers every request with an HTML 503 page. `ad sql`
// first fetches the database list, so that read as SQL_DATABASES_FETCH_FAILED
// (a database problem). A gateway answer is now ENV_UNAVAILABLE, naming the env.
import { afterEach, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { fetchSqlDatabases, resetExecutableCategoryCache } from "../../lib/sql/api";
import { executeSqlReadQuery } from "../../lib/sql/executor";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = cfg = null;
  resetExecutableCategoryCache();
});

const STOPPED = respond({ status: 503, text: "<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>" });

async function errorOf(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected a failure");
}

test("the database list on a stopped env: ENV_UNAVAILABLE, not SQL_DATABASES_FETCH_FAILED", async () => {
  cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
  ff = fakeFetch([{ method: "GET", url: "/rest/api/automation-systems/db_service/auth", response: STOPPED }]).install();
  const e = await errorOf(() => fetchSqlDatabases());
  expect(e.code).toBe("ENV_UNAVAILABLE");
  expect(e.message).toContain("'dev' is unavailable (HTTP 503)");
  expect(e.message).toContain("not a database problem");
});

test("other errors keep their SQL code", async () => {
  cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
  ff = fakeFetch([{ method: "GET", url: "/rest/api/automation-systems/db_service/auth", response: respond({ status: 500, text: "boom" }) }]).install();
  expect((await errorOf(() => fetchSqlDatabases())).code).toBe("SQL_DATABASES_FETCH_FAILED");
});

test("the statement POST on a stopped env: ENV_UNAVAILABLE", async () => {
  cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
  ff = fakeFetch([
    { method: "GET", url: /chain\/category/, response: [{ id: 7, name: "Helpers", accessMode: "PUBLIC" }] },
    { method: "POST", url: "/rest/api/automation/chain/test", response: STOPPED },
  ]).install();
  const template = { category: { id: 7 }, jsonDefinition: JSON.stringify({ services: [{ automationApiId: 19, mappings: [{ encodingType: "BASE_64", value: "" }] }] }) };
  const e = await errorOf(() =>
    executeSqlReadQuery({
      query: "select 1",
      database: { id: 1, nickname: "db", source: null, host: null, port: null, authUsageType: null, derivedAuthType: null },
      context: { operation: { id: 19, methodUUID: "abc" } as any, template: template as any },
    }),
  );
  expect(e.code).toBe("ENV_UNAVAILABLE");
});
