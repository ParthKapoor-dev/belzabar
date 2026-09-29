// Stage 7.2 — structural `ad save` ops (lib/serialize/ops.ts + compact.ts) on
// real sems-dev V2 bodies, with callee contracts / db accounts from the slim
// sems-dev captures (tests/fixtures/validate/online). Also verifyStructural,
// the post-save check used for ops and creates.
import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { planV2Overlay } from "../../lib/serialize/v2";
import { dbMethodForSql, emptyCatalog, type ServiceCatalog } from "../../lib/serialize/compact";
import { structuralRemovals, verifyStructural } from "../../lib/save/pipeline";
import { decodeBase64Strict } from "../../lib/base64";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;
const ON = `${FIX}/validate/online`;
const real = (u: string): V2MethodResponse => structuredClone(require(`${FIX}/real-v2/${u}.v2.json`));
// DRAFT, 11 steps: 1 SQL read, 2 CC (plain), 3 SQL add, 4 Schools-Utilities/find.initials…, …
const U = "41bb1b438875bd8b994196db1f12b7c2";
const B64_SQL = "4ada8d56841853491129898f5069679e"; // DRAFT; step 1 SQL in a BASE_64 slot holding base64
const B64_CC = "438185931da72f5b89aaac3c6248a18e"; // step 12 custom code stored base64

export function catalog(): ServiceCatalog {
  const c = emptyCatalog();
  c.contracts.set("Helpers.Legacy/echo", require(`${ON}/api-echo.json`));
  c.contracts.set("db_service/data.read", require(`${ON}/api-db-select.json`));
  c.contracts.set("Nope.Svc/missing", null);
  c.accounts.set("db_service", (require(`${ON}/auth-db_service.json`) as Array<{ id: number; nickname: string }>).map((a) => ({ id: a.id, nickname: a.nickname })));
  return c;
}

const plan = (live: V2MethodResponse, ops: unknown[], extra: Record<string, unknown> = {}) =>
  planV2Overlay(live, { ...extra, ops }, { catalog: catalog() });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CliError) return e.code;
    throw e;
  }
  throw new Error("expected a CliError");
};
const ids = (b: V2MethodResponse) => (b.steps ?? []).map((s) => s.id ?? "no-id");
const echo = { service: "Helpers.Legacy/echo", inputs: { Input: "Hi #{code}" }, outputs: [{ key: "response", as: "greet" }] };

describe("step placement: positions are the fetched draft's", () => {
  const live = real(U);
  const id = (n: number) => live.steps![n - 1]!.id ?? "no-id"; // step 2 (custom code) has no id on the wire

  test("add after N / before N / after 0 / append; several after one anchor keep op order", () => {
    const p = plan(live, [
      { op: "add-step", after: 2, step: echo },
      { op: "add-step", after: 2, step: { ...echo, outputs: [{ key: "response", as: "greet2" }] } },
      { op: "add-step", before: 1, step: { ...echo, outputs: [{ key: "response", as: "greet0" }] } },
      { op: "add-step", after: 0, step: { ...echo, outputs: [{ key: "response", as: "greetFirst" }] } },
      { op: "add-step", step: { ...echo, outputs: [{ key: "response", as: "greetLast" }] } },
    ]);
    expect(p.structural!.order).toEqual([null, null, 1, 2, null, null, 3, 4, 5, 6, 7, 8, 9, 10, 11, null]);
    const fc = (i: number) => (p.body.steps![i]!.outputs as Array<{ fieldCode: string }>)[0]!.fieldCode;
    // `before: 1` lands in front of step 1; `after: 0` is the very start, so it goes first.
    expect([fc(0), fc(1), fc(4), fc(5), fc(15)]).toEqual(["greetFirst", "greet0", "greet", "greet2", "greetLast"]);
    expect(p.structural!.touched).toEqual(["steps[0]", "steps[1]", "steps[4]", "steps[5]", "steps[15]"]);
  });

  test("remove, move and update all name fetched positions, whatever order the ops come in", () => {
    const p = plan(live, [
      { op: "remove-step", step: 3 },
      { op: "move-step", step: 5, before: 1 },
      { op: "update-step", step: 4, set: { description: "renamed" } },
      { op: "move-step", step: 11, after: 4 },
    ]);
    expect(p.structural!.order).toEqual([5, 1, 2, 4, 11, 6, 7, 8, 9, 10]);
    expect(ids(p.body)).toEqual([5, 1, 2, 4, 11, 6, 7, 8, 9, 10].map(id));
    expect(p.body.steps![3]!.description).toBe("renamed");
    expect(p.structural!.touched).toEqual(["steps[3]"]);
    expect(p.applied).toEqual(["remove-step 3", "move-step 5 before 1", "update-step 4 (description)", "move-step 11 after 4"]);
    // L0: every untouched step is byte-identical to the fetched one.
    for (const [i, from] of p.structural!.order.entries()) if (from !== 4) expect(p.body.steps![i]).toEqual(live.steps![from! - 1]!);
    expect(p.body.metadata).toEqual(live.metadata);
  });

  test("placement refusals → AD_OVERLAY_INVALID", () => {
    for (const ops of [
      [{ op: "remove-step", step: 12 }], // out of range
      [{ op: "remove-step", step: 0 }],
      [{ op: "remove-step", step: 2 }, { op: "remove-step", step: 2 }],
      [{ op: "remove-step", step: 2 }, { op: "add-step", after: 2, step: echo }], // anchor removed
      [{ op: "add-step", after: 2, step: echo }, { op: "remove-step", step: 2 }], // removing an anchor
      [{ op: "move-step", step: 2 }], // no anchor
      [{ op: "move-step", step: 2, after: 2 }], // relative to itself
      [{ op: "move-step", step: 2, after: 1, before: 3 }],
      [{ op: "update-step", step: 2, set: { description: "x" } }, { op: "remove-step", step: 2 }],
      [{ op: "update-step", step: 4, set: { service: "Helpers.Legacy/echo" } }],
      [{ op: "update-step", step: 4, set: { codeFile: "x.js" } }], // unresolved file ref
      ["not an op"],
    ]) {
      expect(code(() => plan(live, ops as unknown[]))).toBe("AD_OVERLAY_INVALID");
    }
  });

  test("unknown op / op field / step field → AD_OVERLAY_UNKNOWN_KEY", () => {
    expect(code(() => plan(live, [{ op: "rename-step", step: 1 }]))).toBe("AD_OVERLAY_UNKNOWN_KEY");
    expect(code(() => plan(live, [{ op: "remove-step", step: 1, why: "x" }]))).toBe("AD_OVERLAY_UNKNOWN_KEY");
    expect(code(() => plan(live, [{ op: "add-step", step: { ...echo, colour: "red" } }]))).toBe("AD_OVERLAY_UNKNOWN_KEY");
    expect(code(() => plan(live, [{ op: "update-step", step: 4, set: { entry: "x" } }]))).toBe("AD_OVERLAY_UNKNOWN_KEY");
  });

  test("legacy parsedSteps edits combine with ops; editing a removed step is refused", () => {
    const p = plan(live, [{ op: "move-step", step: 2, after: 3 }], { parsedSteps: [{ orderIndex: 2, description: "cc moved" }] });
    expect(p.structural!.order.slice(0, 4)).toEqual([1, 3, 2, 4]);
    expect(p.body.steps![2]!.description).toBe("cc moved");
    expect(p.structural!.touched).toContain("steps[2]");
    expect(code(() => plan(live, [{ op: "remove-step", step: 2 }], { parsedSteps: [{ orderIndex: 2, description: "x" }] }))).toBe(
      "AD_OVERLAY_INVALID",
    );
  });

  test("an overlay whose ops change nothing is refused", () => {
    expect(code(() => plan(live, [{ op: "update-step", step: 1, set: { async: false } }]))).toBe(
      "AD_OVERLAY_NOT_APPLIED",
    );
    expect(code(() => plan(live, []))).toBe("AD_OVERLAY_NOT_APPLIED");
  });
});

describe("add-step: compact step → V2 wire", () => {
  const live = real(U);

  test("service step: automationAPIId, input and output uuids from the contract; output → variable", () => {
    const p = plan(live, [
      { op: "set-variable", key: "greeting" },
      { op: "add-step", step: { ...echo, description: "greet", outputs: [{ key: "response", as: "greetOut", var: "greeting" }] } },
    ]);
    const s = p.body.steps!.at(-1)!;
    expect(s).toMatchObject({
      automationAPIId: "424ffd4c9e0f55befc238dd999dab2d6    ",
      serviceName: "Helpers.Legacy",
      methodName: "echo",
      description: "greet",
      inputs: [{ uuid: "4bd0e87488b2cf0ff019850ab3ae069c    ", key: "Input", value: "Hi #{code}", combineInput: true, encodingType: "NONE" }],
      outputs: [{ uuid: "454b0e868e7fdf20249caae851c08208    ", key: "response", fieldCode: "greetOut", name: "greetOut", inputReference: { type: "method_input", reference: "greeting" } }],
      properties: { type: "EXISTING_SERVICE", runAsync: false, exitCondition: { exitOnFailure: { value: true } } },
    });
    expect(s.id).toBeUndefined(); // the server mints step ids
    expect(p.body.variables).toEqual([{ key: "greeting", name: "greeting", type: "STRING", required: false, properties: [], encodingType: "NONE" }]);
  });

  test("sql step: db_service method from the verb, nested body.queryString, account by nickname or the only one", () => {
    expect(["SELECT 1", " with x as (select 1) select * from x", "INSERT INTO t VALUES (1)", "update t set a=1", "-- c\nDELETE FROM t", "create table t()"].map(dbMethodForSql)).toEqual([
      "data.read", "data.read", "data.add", "data.update", "data.delete", "schema.modify",
    ]);
    const p = plan(live, [{ op: "add-step", after: 0, step: { sql: "SELECT '#{code}' AS c", account: "BCPS-RDS", outputs: { rows: "flatData[]" } } }]);
    const s = p.body.steps![0]!;
    expect(s).toMatchObject({
      automationAPIId: "15805db3-0a4f-4f2a-80d8-c433a1ffeced",
      serviceName: "db_service",
      methodName: "data.read",
      accountConfiguration: { id: 2, name: "BCPS-RDS" },
      inputs: [
        {
          uuid: "8d49cef8-1a21-4214-9ebd-20e7174fec0c",
          key: "body",
          type: "OBJECT",
          combineInput: false,
          properties: [{ uuid: "529f4d30-4692-46b3-b1fb-0fea77c68683", key: "queryString", value: "SELECT '#{code}' AS c", combineInput: true, encodingType: "NONE" }],
        },
      ],
      outputs: [{ uuid: "fd4d3307-7178-4df2-bfa1-2a32cb5b3392", key: "flatData[]", fieldCode: "rows", name: "rows" }],
    });
    // several accounts and none named → refused with the list
    expect(code(() => plan(live, [{ op: "add-step", step: { sql: "SELECT 1" } }]))).toBe("AD_OVERLAY_INVALID");
    const one = catalog();
    one.accounts.set("db_service", [{ id: 7, nickname: "only" }]);
    const q = planV2Overlay(live, { ops: [{ op: "add-step", step: { sql: "SELECT 1" } }] }, { catalog: one });
    expect(q.body.steps!.at(-1)!.accountConfiguration).toEqual({ id: 7, name: "only" });
  });

  test("custom code: stored plain (base64 only when the source itself is base64); multi-output gets elementToRetrieve", () => {
    const p = plan(live, [{ op: "add-step", step: { code: "console.log(JSON.stringify({a:1,b:2}))", outputs: ["a", { key: "b", type: "NUMBER" }] } }]);
    const s = p.body.steps!.at(-1)!;
    expect(s.properties!.type).toBe("CUSTOM_CODE");
    expect(s.properties!.customCode).toMatchObject({ inlineCode: "console.log(JSON.stringify({a:1,b:2}))", language: "JAVASCRIPT", executor: "CODE_LAMBDA" });
    expect(s.outputs).toEqual([
      { key: "a", fieldCode: "a", name: "a", type: "TEXT", elementToRetrieve: "a" },
      { key: "b", fieldCode: "b", name: "b", type: "NUMBER", elementToRetrieve: "b" },
    ]);
    // A source that is itself canonical base64 text would be decoded by the sniffing runtime: store it encoded.
    const src = "Y29uc29sZS5sb2coMSk=";
    const b64ish = plan(live, [{ op: "add-step", step: { code: src, outputs: ["x"] } }]).body.steps!.at(-1)!;
    expect(decodeBase64Strict(b64ish.properties!.customCode!.inlineCode!)).toBe(src);
  });

  test("conditions, exit pair, loops, async", () => {
    const p = plan(live, [
      {
        op: "add-step",
        step: { ...echo, when: "#{code} ne null", exit: { onFailure: false, code: "400", message: "bad" }, exitIf: { when: "#{greet} eq ''" }, async: false, loop: { over: "#{list}", counter: "i", parallel: true, threads: 4 } },
      },
    ]);
    const props = p.body.steps!.at(-1)!.properties!;
    expect(props.entryCondition).toEqual({ expression: "#{code} ne null", expandedExpressions: null });
    // One code/message pair per step, mirrored into both blocks by the server (live sems-dev); code is an integer.
    expect(props.exitCondition).toEqual({
      exitOnFailure: { value: false, code: 400, message: "bad" },
      conditionalExit: { code: 400, message: "bad", expression: "#{greet} eq ''", expandedExpressions: null },
    });
    expect(props.repeatStepExecution).toEqual({ type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", counter: "#{i}", executeParallel: true, numberOfConcurrentThread: 4, value: "#{list}" });
    const loop = (l: unknown) => plan(live, [{ op: "add-step", step: { ...echo, loop: l } }]).body.steps!.at(-1)!.properties!.repeatStepExecution;
    // numbers go out as strings: the server stores them so (live), and verify compares the read-back
    expect(loop({ times: 3 })).toMatchObject({ type: "LOOP_EXECUTION_ON_NUMBER", value: "3" });
    expect(loop({ from: 1, to: 3, by: 1 })).toMatchObject({ type: "LOOP_EXECUTION_ON_RANGE", rangeStartInclusive: "1", rangeEndExclusive: "3", incrementalCount: "1" });
    expect(loop({ while: "#{n} lt 3" })).toMatchObject({ type: "LOOP_EXECUTION_ON_CONDITION", value: "#{n} lt 3" });
    expect(loop({ from: 0, to: 5, by: 2 })).toMatchObject({ type: "LOOP_EXECUTION_ON_RANGE", rangeStartInclusive: "0", rangeEndExclusive: "5", incrementalCount: "2" });
    for (const bad of [{ times: 1, while: "x" }, { from: 1 }, "x"]) {
      expect(code(() => plan(live, [{ op: "add-step", step: { ...echo, loop: bad } }]))).toBe("AD_OVERLAY_INVALID");
    }
    expect(code(() => plan(live, [{ op: "add-step", step: { ...echo, exit: { code: "oops" } } }]))).toBe("AD_OVERLAY_INVALID");
    expect(code(() => plan(live, [{ op: "add-step", step: { ...echo, exit: { message: "a" }, exitIf: { when: "#{x}", message: "b" } } }]))).toBe(
      "AD_OVERLAY_INVALID",
    );
  });

  test("keys the server would drop are refused (AD_OVERLAY_NOT_APPLIED)", () => {
    for (const step of [
      { service: "Helpers.Legacy/echo", inputs: { input: "wrong case" } }, // not in the contract
      { service: "Helpers.Legacy/echo", outputs: ["result"] }, // not an output of echo
      { service: "Nope.Svc/missing" }, // no such API (404 on save)
      { sql: "SELECT 1", account: 999 }, // not an account of db_service (500 on save)
    ]) {
      expect(code(() => plan(live, [{ op: "add-step", step }]))).toBe("AD_OVERLAY_NOT_APPLIED");
    }
    // A service whose contract was not loaded cannot take new inputs.
    expect(code(() => planV2Overlay(live, { ops: [{ op: "add-step", step: echo }] }, { catalog: emptyCatalog() }))).toBe("AD_OVERLAY_NOT_APPLIED");
  });

  test("malformed compact steps → AD_OVERLAY_INVALID", () => {
    for (const step of [
      {}, // no kind
      { code: "x", service: "Helpers.Legacy/echo" }, // both kinds
      { service: "echo" }, // not Service/method
      { service: "Helpers.Legacy/echo", sql: "SELECT 1" }, // sql on a non-db service
      { code: "console.log(1)", outputs: [{ key: "a", as: "b" }] }, // CC output renamed (server rewrites fieldCode := key)
      { code: "console.log(1)", inputs: { a: "b" } },
    ]) {
      const c = code(() => plan(live, [{ op: "add-step", step }]));
      expect(["AD_OVERLAY_INVALID", "AD_OVERLAY_NOT_APPLIED"]).toContain(c);
    }
  });
});

describe("update-step on existing steps", () => {
  test("sql keeps the slot's encoding (BASE_64 slot with base64 stays base64); plain stays plain", () => {
    const b = real(B64_SQL);
    const p = plan(b, [{ op: "update-step", step: 1, set: { sql: "SELECT 42" } }]);
    const slot = (p.body.steps![0]!.inputs![0]!.properties as Array<{ key: string; value: string }>).find((x) => x.key === "queryString")!;
    expect(decodeBase64Strict(slot.value)).toBe("SELECT 42");
    const q = plan(real(U), [{ op: "update-step", step: 1, set: { sql: "SELECT 42" } }]);
    expect((q.body.steps![0]!.inputs![0]!.properties as Array<{ key: string; value: string }>).find((x) => x.key === "queryString")!.value).toBe("SELECT 42");
  });

  test("code keeps the stored encoding: base64 stays base64, plain stays plain", () => {
    const b = real(B64_CC);
    b.metadata.state = "DRAFT";
    const p = plan(b, [{ op: "update-step", step: 12, set: { code: "console.log(2)" } }]);
    expect(decodeBase64Strict(p.body.steps![11]!.properties!.customCode!.inlineCode!)).toBe("console.log(2)");
    const q = plan(real(U), [{ op: "update-step", step: 2, set: { code: "console.log(2)" } }]);
    expect(q.body.steps![1]!.properties!.customCode!.inlineCode).toBe("console.log(2)");
  });

  test("kind mismatches are refused: sql on custom code, code on a service step", () => {
    const live = real(U);
    expect(code(() => plan(live, [{ op: "update-step", step: 2, set: { sql: "SELECT 1" } }]))).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(code(() => plan(live, [{ op: "update-step", step: 1, set: { code: "x" } }]))).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(code(() => plan(live, [{ op: "update-step", step: 4, set: { account: 2 } }]))).toBe("AD_OVERLAY_NOT_APPLIED");
  });

  test("inputs: existing keys keep uuid/type, SpEL turns combineInput on, null removes; outputs upsert/remove by fieldCode", () => {
    const live = real(U);
    const before = structuredClone(live.steps![3]!.inputs![0]!);
    const outKey = live.steps![3]!.outputs![0]!.key;
    const p = plan(live, [
      { op: "update-step", step: 4, set: { inputs: { display_name: "#{stage_name}!" }, outputs: [{ key: outKey, as: "stage_name_initials", type: "TEXT" }] } },
      { op: "update-step", step: 1, set: { removeOutputs: ["enrollment_stage_type_count"], when: null } },
    ]);
    const inp = p.body.steps![3]!.inputs![0]!;
    expect(inp).toEqual({ ...before, value: "#{stage_name}!", combineInput: true });
    expect(p.body.steps![3]!.outputs![0]).toEqual({ ...live.steps![3]!.outputs![0]!, type: "TEXT" });
    expect((p.body.steps![0]!.outputs ?? []).map((o) => o.fieldCode)).toEqual(["enrollment_stage_type_info"]);
    expect(p.body.steps![0]!.properties!.entryCondition!.expression).toBeNull();
    const r = plan(live, [{ op: "update-step", step: 4, set: { inputs: { display_name: null } } }]);
    expect(r.body.steps![3]!.inputs).toEqual([]);
    expect(code(() => plan(live, [{ op: "update-step", step: 1, set: { removeOutputs: ["nope"] } }]))).toBe("AD_OVERLAY_NOT_APPLIED");
  });

  test("update-step outputs MERGE; replaceOutputs REPLACES the list (CLI trial)", () => {
    const live = real(U);
    const fcs = (b: typeof live, i: number) => (b.steps![i]!.outputs ?? []).map((o) => o.fieldCode);
    expect([...fcs(live, 0)].sort()).toEqual(["enrollment_stage_type_count", "enrollment_stage_type_info"]);
    const info = live.steps![0]!.outputs!.find((o) => o.fieldCode === "enrollment_stage_type_info")!;
    // replace: only the listed fieldCode stays, keeping its uuid/fields
    const r = plan(live, [{ op: "update-step", step: 1, set: { replaceOutputs: [{ key: info.key, as: "enrollment_stage_type_info" }] } }]);
    expect(fcs(r.body, 0)).toEqual(["enrollment_stage_type_info"]);
    expect(r.body.steps![0]!.outputs![0]).toEqual(info);
    // merge (outputs) keeps both
    const m = plan(live, [{ op: "update-step", step: 1, set: { outputs: [{ key: info.key, as: "enrollment_stage_type_info", type: "JSON" }] } }]);
    expect(fcs(m.body, 0)).toEqual(fcs(live, 0));
    // replaceOutputs is the whole list: not with outputs / removeOutputs; not an add-step key
    expect(code(() => plan(live, [{ op: "update-step", step: 1, set: { replaceOutputs: [], removeOutputs: ["x"] } }]))).toBe("AD_OVERLAY_INVALID");
    expect(code(() => plan(live, [{ op: "add-step", step: { sql: "SELECT 1", replaceOutputs: [] } }]))).toBe("AD_OVERLAY_UNKNOWN_KEY");
  });

  test("account change also moves databaseRead.account (the server keeps them in step)", () => {
    const live = real(U);
    (live.steps![0]!.properties as unknown as Record<string, unknown>).databaseRead = { query: null, account: "2" };
    const p = plan(live, [{ op: "update-step", step: 1, set: { account: "BCPS-Test-RDS" } }]);
    expect(p.body.steps![0]!.accountConfiguration).toEqual({ id: 5, name: "BCPS-Test-RDS" });
    expect((p.body.steps![0]!.properties as Record<string, any>).databaseRead.account).toBe("5");
  });
});

describe("method inputs / variables / outputs", () => {
  test("set-* upserts (new appended with defaults; existing merged, uuid kept), remove-* deletes", () => {
    const live = real(U);
    const p = plan(live, [
      { op: "set-input", key: "suffix", required: true, default: "!", description: "tail" },
      { op: "set-input", key: "code", description: "the code" },
      { op: "remove-input", key: "application_type" },
      { op: "set-output", key: "result", type: "TEXT" },
      { op: "set-variable", key: "tmp", default: 0, type: "INTEGER" },
    ]);
    expect(p.body.inputs!.map((i) => i.key)).toEqual(["code", "stage_name", "suffix"]);
    expect(p.body.inputs![0]).toEqual({ ...live.inputs![0]!, description: "the code" });
    expect(p.body.inputs![2]).toEqual({ key: "suffix", name: "suffix", type: "STRING", required: true, properties: [], encodingType: "NONE", description: "tail", defaultValue: "!" });
    expect(p.body.outputs as unknown[]).toEqual([{ key: "result", fieldCode: "result", name: "result", type: "TEXT" }]);
    expect(p.body.variables as unknown[]).toEqual([{ key: "tmp", name: "tmp", type: "INTEGER", required: false, properties: [], encodingType: "NONE", defaultValue: 0 }]);
    expect(p.structural!.touched).toEqual(["inputs[0]", "inputs[2]", "variables[0]", "outputs[0]"]);
  });

  test("refusals: testValue and a variable's BASE_64 (dropped by the server), a missing key, unknown field", () => {
    const live = real(U);
    expect(code(() => plan(live, [{ op: "set-input", key: "code", testValue: "x" }]))).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(code(() => plan(live, [{ op: "set-variable", key: "v", encodingType: "BASE_64" }]))).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(code(() => plan(live, [{ op: "remove-variable", key: "nope" }]))).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(code(() => plan(live, [{ op: "set-input", key: "" }]))).toBe("AD_OVERLAY_INVALID");
    expect(code(() => plan(live, [{ op: "set-input", key: "a", colour: 1 }]))).toBe("AD_OVERLAY_UNKNOWN_KEY");
  });
});

describe("verifyStructural (post-save check for ops and creates)", () => {
  const expected = {
    name: "m",
    metadata: { version: { name: "1" }, service: { id: 1 } },
    steps: [
      { id: "a".repeat(32), description: "untouched" },
      { automationAPIId: "b".repeat(32), inputs: [{ key: "Input", value: "x" }] },
    ],
  };
  const touched = ["steps[1]"];
  const ok = (after: unknown, t = touched) => verifyStructural("u", expected, after, t);
  const fails = (after: unknown, t = touched) => {
    try {
      ok(after, t);
    } catch (e) {
      return (e as CliError).details as { notLanded: Array<{ path: string }>; unexpected: string[] };
    }
    throw new Error("expected AD_SAVE_VERIFY_FAILED");
  };
  const after = () => structuredClone(expected) as any;

  test("server-filled ids/uuids/types under touched paths and padded uuids are tolerated; bookkeeping ignored", () => {
    const a = after();
    a.steps[1].id = "c".repeat(32);
    a.steps[1].automationAPIId = `${"B".repeat(32)}    `;
    a.steps[1].inputs[0].uuid = "u1";
    a.steps[1].inputs[0].type = "STRING";
    a.metadata.version.name = "2";
    a.metadata.service.description = "server fills it"; // outside touched, but under metadata? → unexpected
    expect(fails(a).unexpected).toEqual(["metadata.service.description"]);
    delete a.metadata.service.description;
    expect(() => ok(a)).not.toThrow();
    expect(() => ok({ ...a, metadata: { ...a.metadata, service: { id: 1, description: "x" } } }, [""])).not.toThrow(); // create: everything touched
  });

  test("a sent value that reads back different or missing is notLanded; a change elsewhere is unexpected", () => {
    const a = after();
    a.steps[1].inputs[0].value = "y";
    a.steps[0].description = "changed";
    const d = fails(a);
    expect(d.notLanded.map((n) => n.path)).toEqual(["steps[1].inputs[0].value"]);
    expect(d.unexpected).toEqual(["steps[0].description"]);
    const b = after();
    b.steps[1].inputs = []; // the server dropped the input
    expect(fails(b).notLanded.map((n) => n.path)).toEqual(["steps[1].inputs[0]"]);
  });
});

describe("ADW-R7: removals must not be mistaken for server-filled fields", () => {
  const live = {
    name: "m",
    outputs: [{ key: "keep", type: "TEXT" }, { key: "gone", type: "TEXT" }],
    steps: [
      { id: "s1", description: "untouched" },
      {
        id: "s2",
        inputs: [{ key: "a", value: "1" }, { key: "b", value: "2" }],
        outputs: [{ key: "response", fieldCode: "x", inputReference: { type: "method_input", reference: "v" } }, { key: "response", fieldCode: "y" }],
        properties: { runAsync: false, repeatStepExecution: { type: "LOOP_EXECUTION_ON_INPUT_OUTPUT", value: "#{rows}" } },
      },
    ],
  };
  // update-step 2 {removeOutputs:["y"], inputs:{b:null}, loop:null, outputs:[{as:"x", var:null}]} + remove-output gone
  const expected = structuredClone(live) as any;
  expected.outputs.splice(1, 1);
  expected.steps[1].inputs.splice(1, 1);
  expected.steps[1].outputs.splice(1, 1);
  delete expected.steps[1].outputs[0].inputReference;
  delete expected.steps[1].properties.repeatStepExecution;
  const order = [1, 2];
  const removals = structuralRemovals(live, expected, order);
  const touched = ["steps[1]"];

  test("the removals are recorded", () => {
    expect(removals).toEqual([
      { path: "outputs", key: "gone" },
      { path: "steps[1].inputs", key: "b" },
      { path: "steps[1].outputs[0].inputReference" },
      { path: "steps[1].outputs", key: "response|y" },
      { path: "steps[1].properties.repeatStepExecution" },
    ]);
  });

  test("landed removals verify (an all-null loop object counts as none)", () => {
    const after = structuredClone(expected);
    after.steps[1].properties.repeatStepExecution = { type: null, value: null };
    expect(() => verifyStructural("u", expected, after, touched, removals)).not.toThrow();
  });

  test("an output, input, loop or binding the server kept is notLanded", () => {
    const after = structuredClone(expected);
    after.steps[1].outputs.push({ key: "response", fieldCode: "y" });
    after.steps[1].inputs.push({ key: "b", value: "2" });
    after.steps[1].properties.repeatStepExecution = live.steps[1]!.properties!.repeatStepExecution;
    after.steps[1].outputs[0].inputReference = { type: "method_input", reference: "v" };
    let details: any;
    try {
      verifyStructural("u", expected, after, touched, removals);
    } catch (e) {
      details = (e as CliError).details;
    }
    expect(details?.notLanded.map((n: any) => n.path)).toEqual([
      "steps[1].inputs{b}",
      "steps[1].outputs[0].inputReference",
      "steps[1].outputs{response|y}",
      "steps[1].properties.repeatStepExecution",
    ]);
    // without the removals the old check passed these as server-filled
    expect(() => verifyStructural("u", expected, after, touched)).not.toThrow();
  });
});

