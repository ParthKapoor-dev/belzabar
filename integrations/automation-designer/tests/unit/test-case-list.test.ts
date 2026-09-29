// F24: `ad test-case list` returns the same structured result as `ad test-cases`
// (it returned the raw body — `null` for a method without a suite).
import { afterEach, describe, expect, test } from "bun:test";
import { respond, runCommand } from "@belzabar/core/testing";
import testCaseCommand from "../../commands/test-case/index";
import testCasesCommand from "../../commands/test-cases/index";
import { readFileSync } from "fs";
import { join } from "path";
import { fakeAdEnv } from "./helpers/fake-ad";

const UUID = "4bdea25c480a8e9dbc1cae830cb89b68";
const ad = fakeAdEnv({ quiet: false });
afterEach(() => ad.restore());

function wire(body: unknown) {
  ad.install({
    [`GET /rest/api/automation/chain/testsuite/service-chain/${UUID}`]:
      body === null ? respond({ status: 200, text: "null" }) : body,
    // The method exists (only read when the suite is empty).
    "GET /rest/api/automation/chain/v2/*": REAL_V2,
  });
}

const REAL_V2 = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "real-v2", "4b108b0554b0daa963f4bd6985f0de52.v2.json"), "utf8"),
);

const SUITE = {
  id: "suite-1",
  active: true,
  executionStatus: "PASS",
  testCases: [{ id: "tc1", name: "happy", inputs: [{}, {}], assertions: [{}] }],
};

describe("test-case list == test-cases (F24)", () => {
  for (const [label, body] of [["a suite", SUITE], ["no suite (null body)", null]] as const) {
    test(label, async () => {
      wire(body);
      const list = await runCommand(testCaseCommand, ["list", UUID.toUpperCase()], { env: "t-dev" });
      const cases = await runCommand(testCasesCommand, [UUID], { env: "t-dev" });
      expect(list.envelope?.ok).toBe(true);
      const { action, ...rest } = list.envelope?.data as any;
      expect(action).toBe("list");
      expect(rest).toEqual(cases.envelope?.data as any);
      expect(rest.uuid).toBe(UUID);
    });
  }

  test("suite rows", async () => {
    wire(SUITE);
    const r = await runCommand(testCaseCommand, ["list", UUID], { env: "t-dev" });
    expect(r.envelope?.data).toMatchObject({
      testSuiteId: "suite-1",
      total: 1,
      testCases: [{ id: "tc1", name: "happy", active: true, inputCount: 2, assertionCount: 1 }],
    });
  });

  test("an unknown uuid is METHOD_NOT_FOUND, not an empty ok suite (smoke: ok on failure)", async () => {
    ad.install({
      [`GET /rest/api/automation/chain/testsuite/service-chain/${UUID}`]: respond({ status: 200, text: "null" }),
      // Real acme-dev answer for a missing uuid (fixtures/not-found): 200 + empty body.
      "GET /rest/api/automation/chain/v2/*": respond({ status: 200, text: "" }),
    });
    for (const [cmd, argv] of [[testCasesCommand, [UUID]], [testCaseCommand, ["list", UUID]]] as const) {
      const r = await runCommand(cmd, [...argv], { env: "t-dev" });
      expect(r.envelope?.ok).toBe(false);
      expect(r.envelope?.error?.code).toBe("METHOD_NOT_FOUND");
    }
  });
});
