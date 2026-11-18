// C1: a save that landed must not fail AD_SAVE_VERIFY_FAILED because the
// server normalised fields without changing their meaning (encoding flags,
// the account label / databaseRead.account, a condition's basic → advanced
// form). Those are listed in data.normalised and the save is ok; a real
// value difference still fails.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import saveCommand from "../../commands/save/index";
import { normalisedChange, splitNormalised } from "../../lib/save/normalise";
import { verifyStructural } from "../../lib/save/pipeline";
import { __setValidatorsForTests } from "../../lib/save/validation";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { compiledCacheRoutes, fakeAdEnv, v2Store } from "./helpers/fake-ad";

const DIR = `${import.meta.dir}/../fixtures/real-v2`;
const U = "41bb1b438875bd8b994196db1f12b7c2"; // db steps 1/3/5 (account id 3, databaseRead.account "null"), basic conditions
const base = (): V2MethodResponse => structuredClone(require(`${DIR}/${U}.v2.json`));

const ad = fakeAdEnv();
afterEach(() => {
  ad.restore();
  __setValidatorsForTests();
});

function walk(v: unknown, f: (o: Record<string, any>) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walk(x, f));
  else if (v && typeof v === "object") {
    f(v as Record<string, any>);
    Object.values(v).forEach((x) => walk(x, f));
  }
}

/** What the server does to an older method's body on a V2 save (the forms seen live). */
function normaliseLikeServer(body: V2MethodResponse): V2MethodResponse {
  for (const s of body.steps as any[]) {
    if (s.accountConfiguration) {
      s.accountConfiguration.name ??= "ACCOUNT-3";
      s.properties.databaseRead.account = String(s.accountConfiguration.id);
    }
    const ec = s.properties.entryCondition;
    if (ec?.expression) ec.expandedExpressions = [];
    walk(s.inputs, (o) => {
      if ("encodedBase64" in o) o.encodedBase64 = false;
    });
  }
  return body;
}

function overlayFile(o: unknown): string {
  const p = join(scratchDir("ad-save-normalise"), `o-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(o));
  return p;
}

function wire(onPost: (b: V2MethodResponse) => V2MethodResponse, initial = base()) {
  const s = v2Store(U, initial, { onPost });
  ad.install([...s.routes, { method: "GET", url: `/rest/api/automation/chain/${U}`, response: { uuid: U, jsonDefinition: "{}" } }, ...compiledCacheRoutes()]);
  return s;
}
const run = (overlay: unknown) => runCommand(saveCommand, [overlayFile(overlay), "--uuid", U, "--yes"], { env: "t-dev" });

describe("normalisedChange (pure)", () => {
  const step = (over: Record<string, unknown> = {}) => ({ steps: [{ accountConfiguration: { id: 2, name: "RDS" }, inputs: [{ value: "x", encodedBase64: true }], properties: { databaseRead: { account: "null" }, entryCondition: { expression: "#{a} eq 1", expandedExpressions: [{ row: 1 }] } }, ...over }] });
  test("encoding: the flag, and a value that only moved between base64 and plain", () => {
    const a = step();
    const b = step({ inputs: [{ value: Buffer.from("x").toString("base64"), encodedBase64: false }] });
    expect(splitNormalised(a, b, ["steps[0].inputs[0].value", "steps[0].inputs[0].encodedBase64"]).real).toEqual([]);
    const c = step({ inputs: [{ value: "y", encodedBase64: true }] });
    expect(normalisedChange(a, c, "steps[0].inputs[0].value")).toBeNull();
  });
  test("account: the label gaining its name, databaseRead.account becoming the step's account id", () => {
    const a = step({ accountConfiguration: { id: 2, name: null } });
    const b = step({ properties: { databaseRead: { account: "2" }, entryCondition: step().steps[0]!.properties.entryCondition } });
    expect(normalisedChange(a, b, "steps[0].accountConfiguration.name")).toMatchObject({ kind: "account", from: null, to: "RDS" });
    expect(normalisedChange(a, b, "steps[0].properties.databaseRead.account")).toMatchObject({ kind: "account", from: "null", to: "2" });
    // another account is a real change
    const other = step({ accountConfiguration: { id: 2, name: "RDS" }, properties: { databaseRead: { account: "7" }, entryCondition: {} } });
    expect(normalisedChange(a, other, "steps[0].properties.databaseRead.account")).toBeNull();
    expect(normalisedChange(step(), step({ accountConfiguration: { id: 2, name: "OTHER" } }), "steps[0].accountConfiguration.name")).toBeNull();
  });
  test("condition: basic → advanced with the same expression is one entry; a new expression is real", () => {
    const a = step();
    const b = step({ properties: { databaseRead: { account: "null" }, entryCondition: { expression: "#{a} eq 1", expandedExpressions: [] } } });
    const r = splitNormalised(a, b, ["steps[0].properties.entryCondition.expandedExpressions[0]"]);
    expect(r).toEqual({ normalised: [{ path: "steps[0].properties.entryCondition", kind: "condition-form", from: "basic", to: "advanced" }], real: [] });
    const c = step({ properties: { databaseRead: { account: "null" }, entryCondition: { expression: "#{a} eq 2", expandedExpressions: [] } } });
    expect(splitNormalised(a, c, ["steps[0].properties.entryCondition.expression", "steps[0].properties.entryCondition.expandedExpressions[0]"]).real).toHaveLength(2);
  });
});

describe("ad save: server normalisation is not a failed verify (C1)", () => {
  test("a description save on an older method: ok, the new version, normalised[] and a warning", async () => {
    const old = base();
    (old.steps as any[])[0].inputs[0].encodedBase64 = true;
    wire(normaliseLikeServer, old);
    const r = await run({ description: "x" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope!.data as any;
    expect(d.version).toBe(String(Number(base().metadata.version!.name) + 1));
    const kinds = new Set(d.normalised.map((n: any) => n.kind));
    expect(kinds).toEqual(new Set(["account", "condition-form", "encoding"]));
    expect(d.normalised).toContainEqual({ path: "steps[0].properties.databaseRead.account", kind: "account", from: "null", to: "3" });
    expect(((r.envelope!.meta as any)?.warnings ?? []).some((w: string) => w.includes("normalised"))).toBe(true);
  });

  test("the same with structural ops (update-step on another step)", async () => {
    wire(normaliseLikeServer);
    const r = await run({ ops: [{ op: "update-step", step: 2, set: { description: "d" } }] });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope!.data as any).normalised.length).toBeGreaterThan(0);
  });

  test("a real change on an untouched step still fails AD_SAVE_VERIFY_FAILED", async () => {
    wire((b) => {
      normaliseLikeServer(b);
      (b.steps as any[])[2].properties.entryCondition.expression = "#{code} eq 'other'";
      return b;
    });
    const r = await run({ description: "x" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("AD_SAVE_VERIFY_FAILED");
    const det = r.envelope?.error?.details as any;
    expect(det.unexpected).toContain("steps[2].properties.entryCondition.expression");
    expect(det.normalised.length).toBeGreaterThan(0);
  });
});

describe("verifyStructural (create): a sent \"null\" account reads back as the account id", () => {
  test("returned as normalised, not notLanded", () => {
    const expected = { steps: [{ accountConfiguration: { id: 215, name: null }, properties: { databaseRead: { query: null, account: "null" } } }] };
    const after = { steps: [{ accountConfiguration: { id: 215, name: "db" }, properties: { databaseRead: { query: null, account: "215" } } }] };
    expect(verifyStructural("u", expected, after, [""]).map((n) => n.path)).toEqual([
      "steps[0].accountConfiguration.name",
      "steps[0].properties.databaseRead.account",
    ]);
  });
});
