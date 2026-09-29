// Smoke UX (Stage 9): every `ad sql` statement took ~5-6 s on sems-dev because
// the executable-category lookup (~2 s) ran only after the operation contract
// and the template had loaded. It now starts first, in parallel.
import { afterEach, expect, test } from "bun:test";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { resetExecutableCategoryCache } from "../../lib/sql/api";
import { loadSqlExecutionContext } from "../../lib/sql/executor";

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = null;
  cfg = null;
  resetExecutableCategoryCache();
});

test("the category lookup is requested before the template GET, not after", async () => {
  resetExecutableCategoryCache();
  cfg = withTempEnvConfig({ envs: { "t-sql": { url: "https://t.test" } }, activeEnv: "t-sql" });
  ff = fakeFetch([
    { method: "GET", url: "/rest/api/automation-systems/db_service/automation-apis/select", response: { id: 19, methodUUID: "abc123" } },
    { method: "GET", url: "/rest/api/automation/chain/abc123", response: { id: 1, uuid: "abc123", jsonDefinition: "{}" } },
    { method: "GET", url: /chain\/category/, response: respond({ status: 200, json: [{ id: 7, name: "Helpers", accessMode: "PUBLIC" }] }) },
  ]).install();
  await loadSqlExecutionContext();
  const paths = ff.requests.map((r) => new URL(r.url).pathname);
  const cat = paths.indexOf("/rest/api/automation/chain/category");
  const tpl = paths.indexOf("/rest/api/automation/chain/abc123");
  expect(cat).toBeGreaterThanOrEqual(0);
  expect(tpl).toBeGreaterThan(cat);
});
