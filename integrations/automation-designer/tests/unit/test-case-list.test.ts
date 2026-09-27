// F24: `ad test-case list` returns the same structured result as `ad test-cases`
// (it returned the raw body — `null` for a method without a suite).
import { afterEach, describe, expect, test } from "bun:test";
import { fakeFetch, respond, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import testCaseCommand from "../../commands/test-case/index";
import testCasesCommand from "../../commands/test-cases/index";

const UUID = "4bdea25c480a8e9dbc1cae830cb89b68";
let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

function wire(body: unknown) {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  ff = fakeFetch({
    [`GET /rest/api/automation/chain/testsuite/service-chain/${UUID}`]:
      body === null ? respond({ status: 200, text: "null" }) : body,
  }).install();
}

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
});
