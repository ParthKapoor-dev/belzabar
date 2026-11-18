// lib/publish-report: callers of inputs a publish removes (C5), on the real
// "Example services" fixtures `ad callers` uses. The suite report (A9) is
// covered through `ad publish` in publish-changelog.test.ts.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { fakeFetch, fixture, respond, withTempEnvConfig, type RecordedRequest } from "@belzabar/core/testing";
import { findRemovedInputCallers, removedInputs } from "../../lib/publish-report";

const FIX = `${import.meta.dir}/../fixtures`;
const CAT = "4423ad307059bc3fc6859804c9bd12e0"; // "Example services"
const ARRAY_OUTPUT = "48e5d8bec3f5d7b5d689914d3b36aed8"; // input "array"; called by "chaining method" (draft) step 1
const CALLER = "40b270670686c47215d2b6ab839b276d";
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };

/** V2 bodies from the fixtures; the caller's step passes `value` to the callee's "array" input. */
function routes(value: string) {
  const v2 = (req: RecordedRequest) => {
    const uuid = req.url.match(/chain\/v2\/([0-9a-f]{32})/)?.[1];
    const file = `${FIX}/callers/v2/${uuid}.json`;
    if (!existsSync(file)) return new Response("", { status: 200 });
    const body = JSON.parse(readFileSync(file, "utf8"));
    if (uuid === CALLER) body.steps[0].inputs[0].value = value;
    return respond({ json: body });
  };
  return {
    "GET /rest/api/automation/services*": respond({
      json: { result: [{ id: 40, uuid: `${CAT}    `, name: "Example services", label: "Example services" }] },
    }),
    [`GET /rest/api/automation/methods?categoryUuid=${CAT}*`]: fixture(`${FIX}/callers/methods-example-services.json`),
    "GET /rest/api/automation/chain/v2/*": v2,
    "GET /rest/api/automation-systems/Example%20services/automation-apis/array%20output": fixture(`${FIX}/child-info/Example_services__array_output.json`),
    "GET /rest/api/automation-systems/*": respond({ text: "" }),
  };
}

describe("removed inputs (C5)", () => {
  test("removedInputs: keys the published copy has and the draft does not", () => {
    expect(removedInputs({ inputs: [{ key: "epId" }, { key: "addForSchools" }] }, { inputs: [{ key: "epId" }, { key: "items" }, { key: "isDelete" }] })).toEqual(["items", "isDelete"]);
    expect(removedInputs({ inputs: [{ key: "a" }] }, { inputs: [{ key: "a" }] })).toEqual([]);
  });

  test("lists the caller step that passes a removed input, with its state", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes("#{rows}")).install();
    const r = await findRemovedInputCallers(ARRAY_OUTPUT, ["array"]);
    expect(r.callers).toEqual([{ name: "chaining method", category: "Example services", state: "DRAFT", uuid: CALLER, step: 1, inputs: ["array"] }]);
  });

  test("a caller step that leaves the input empty is not listed", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes("")).install();
    expect((await findRemovedInputCallers(ARRAY_OUTPUT, ["array"])).callers).toEqual([]);
  });
});
