// `ad create` (spec → V2 create body, WSR-6 category guard, verify) and
// `ad delete` (soft delete of never-published drafts only).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CliError } from "@belzabar/core";
import {
  fakeFetch,
  fixture,
  respond,
  runCommand,
  scratchDir,
  withTempEnvConfig,
  type FakeFetch,
  type RecordedRequest,
  type TempEnvConfig,
} from "@belzabar/core/testing";
import createCommand from "../../commands/create/index";
import deleteCommand from "../../commands/delete/index";
import { assertCreatableCategory, buildCreateBody } from "../../lib/save/create";
import { buildCategories, requireChainCategory, type Category } from "../../lib/categories";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;
const CATS = buildCategories(require(`${FIX}/categories/chain-category.json`), require(`${FIX}/categories/chain-category-system.json`));
const TEST_PARTH = requireChainCategory(CATS, "Test-Parth");
const REAL_V2 = `${FIX}/real-v2`;
const real = (u: string): V2MethodResponse => structuredClone(require(`${FIX}/real-v2/${u}.v2.json`));

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  while (spies.length) spies.pop()!.mockRestore();
});
function env() {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
}
function file(o: unknown): string {
  const p = join(scratchDir("ad-create"), `s-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(o));
  return p;
}

describe("buildCreateBody", () => {
  const minimal = {
    name: "belz_tst_x",
    inputs: [{ key: "name" }],
    outputs: [{ key: "out" }],
    steps: [
      { serviceName: "Helpers.Legacy", methodName: "echo", inputs: [{ key: "Input", value: "Hi #{name}" }], outputs: [{ key: "response", fieldCode: "out" }] },
      { properties: { customCode: { inlineCode: "console.log(1)" } }, outputs: [{ key: "ccOut" }] },
    ],
  };

  test("ADW-R10: fields expand like save's set-input (refusals shared); real V2 method fields still work", () => {
    const code = (spec: unknown) => {
      try {
        buildCreateBody(spec, TEST_PARTH);
      } catch (e) {
        return (e as CliError).code;
      }
      return "ok";
    };
    expect(code({ ...minimal, variables: [{ key: "v", encodingType: "BASE_64" }] })).toBe("AD_SPEC_NOT_APPLIED");
    expect(code({ ...minimal, inputs: [{ key: "a", bogusKey: 1 }] })).toBe("AD_SPEC_UNKNOWN_KEY");
    expect(code({ ...minimal, outputs: [{ type: "TEXT" }] })).toBe("AD_SPEC_INVALID"); // no key
    // every method field of the 36 real bodies (uuid / referenceUuid are server-minted and dropped)
    for (const f of readdirSync(REAL_V2)) {
      if (!f.endsWith(".v2.json")) continue;
      const real = JSON.parse(readFileSync(join(REAL_V2, f), "utf8"));
      const outputs = (real.outputs ?? []).filter((o: any) => typeof o.key === "string" && o.key); // OK1 bodies lack keys
      const { body } = buildCreateBody({ name: "x", inputs: real.inputs ?? [], variables: real.variables ?? [], outputs }, TEST_PARTH);
      for (const o of body.outputs as any[]) expect(o.uuid ?? o.referenceUuid).toBeUndefined();
    }
  });

  test("fills UI defaults; category comes from the flag", () => {
    const { body, dropped } = buildCreateBody(minimal, TEST_PARTH);
    expect(dropped).toEqual([]);
    expect(body.metadata).toEqual({ service: { id: 1135, uuid: TEST_PARTH.chainCategoryUuid, name: "Test-Parth" } });
    expect((body.inputs as any[])[0]).toEqual({ key: "name", name: "name", type: "STRING", required: false, properties: [], encodingType: "NONE" });
    expect((body.outputs as any[])[0]).toEqual({ key: "out", fieldCode: "out", name: "out", type: "STRING" });
    const [echo, cc] = body.steps as any[];
    expect(echo.properties.type).toBe("EXISTING_SERVICE");
    expect(echo.properties.exitCondition.exitOnFailure).toEqual({ value: true, code: null, message: "" });
    expect(echo.inputs[0].combineInput).toBe(true); // SpEL present
    expect(echo.outputs[0]).toEqual({ key: "response", fieldCode: "out", name: "out" });
    expect(cc.properties.type).toBe("CUSTOM_CODE"); // inferred from inlineCode
    expect(cc.properties.customCode).toMatchObject({ inlineCode: "console.log(1)", language: "JAVASCRIPT", executor: "CODE_LAMBDA" });
    expect(cc.outputs[0]).toEqual({ key: "ccOut", fieldCode: "ccOut", name: "ccOut", type: "TEXT" });
  });

  test("a fetched V2 body: server-owned keys dropped, method-level uuids and step ids removed", () => {
    const src = real("41bb1b438875bd8b994196db1f12b7c2");
    const { body, dropped } = buildCreateBody(src, TEST_PARTH);
    expect(dropped).toEqual(expect.arrayContaining(["uuid", "automationApiId", "changelogs", "permissions", "automationState", "metadata.service", "metadata.version", "metadata.state"]));
    for (const k of ["uuid", "automationApiId", "changelogs", "permissions", "automationState"]) expect(body).not.toHaveProperty(k);
    expect(Object.keys(body.metadata as object)).toEqual(["service"]);
    for (const f of [...(body.inputs as any[]), ...(body.outputs as any[])]) expect(f).not.toHaveProperty("uuid");
    for (const s of body.steps as any[]) expect(s).not.toHaveProperty("id");
    // step contents are kept as given (step input uuids reference the service contract)
    expect((body.steps as any[])[0].inputs).toEqual(src.steps![0]!.inputs!.map((i: any) => expect.objectContaining({ key: i.key, uuid: i.uuid })));
  });

  test.each([
    [{ description: "no name" }, "AD_SPEC_INVALID"],
    [{ name: "x", foo: 1 }, "AD_SPEC_UNKNOWN_KEY"],
    [{ name: "x", steps: {} }, "AD_SPEC_INVALID"],
    [[], "AD_SPEC_INVALID"],
  ])("refuses %j → %s", (spec, codeExpected) => {
    try {
      buildCreateBody(spec, TEST_PARTH);
      throw new Error("no throw");
    } catch (e) {
      expect((e as CliError).code).toBe(codeExpected);
    }
  });
});

describe("assertCreatableCategory (WSR-6)", () => {
  const cat = (name: string, type = "USER_GENERATED"): Category => ({ ...TEST_PARTH, name, type });
  test.each(["Helpers.JSON", "Helpers.Legacy", "Database.SQL", "Cache.Redis", "Email", "Expertly.Notification", "Web Socket"])("%s is refused", (n) => {
    expect(() => assertCreatableCategory(cat(n))).toThrow(/core\/shared/);
  });
  test("system services are refused; project categories pass", () => {
    expect(() => assertCreatableCategory(cat("db_service", "SYSTEM_GENERATED"))).toThrow(/system service/);
    expect(() => assertCreatableCategory(TEST_PARTH)).not.toThrow();
    expect(() => assertCreatableCategory(cat("Schools-Notifications"))).not.toThrow();
  });
});

const NEW = "4d42844c66f687f1226eb020eb10f4db";
function wireCreate(post?: (req: RecordedRequest) => unknown) {
  env();
  let stored: any = null;
  ff = fakeFetch([
    { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=false", response: fixture(`${FIX}/categories/chain-category.json`) },
    { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=true", response: fixture(`${FIX}/categories/chain-category-system.json`) },
    {
      method: "POST",
      url: "/rest/api/automation/chain/v2",
      response:
        post ??
        ((req: RecordedRequest) => {
          const b = req.json();
          stored = { ...b, uuid: NEW, metadata: { ...b.metadata, state: "DRAFT", referenceId: null, version: { name: "1" }, service: { ...b.metadata.service, id: 1135 } } };
          return stored;
        }),
    },
    { method: "GET", url: `/rest/api/automation/chain/v2/${NEW}?basicInfo=false`, response: () => stored },
  ]).install();
}
const spec = { name: "belz_tst_s5a_unit", steps: [{ properties: { customCode: { inlineCode: "console.log(1)" } }, outputs: [{ key: "o" }] }] };

describe("ad create", () => {
  test("POSTs a create body (no uuid) and returns the verified uuid", async () => {
    wireCreate();
    const r = await runCommand(createCommand, ["--category", "Test-Parth", "--spec", file(spec), "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope!.data as any;
    expect(d).toMatchObject({ uuid: NEW, name: "belz_tst_s5a_unit", state: "DRAFT", version: "1", stepCount: 1, category: { chainCategoryId: 1135, name: "Test-Parth" } });
    const post = ff!.requests.find((q) => q.method === "POST")!.json();
    expect(post).not.toHaveProperty("uuid");
    expect(post.metadata.service.id).toBe(1135);
  });

  test("core category → AD_CATEGORY_PROTECTED, nothing POSTed", async () => {
    wireCreate();
    const r = await runCommand(createCommand, ["--category", "Helpers.JSON", "--spec", file(spec), "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_CATEGORY_PROTECTED");
    expect(ff!.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  test("duplicate name → AD_METHOD_EXISTS", async () => {
    wireCreate(() =>
      respond({ status: 400, json: { errorMessage: "A method or alias with this name already exists in the service.", data: "error.automation_chain.duplicate_method_name" } }),
    );
    const r = await runCommand(createCommand, ["--category", "1135", "--spec", file(spec), "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_METHOD_EXISTS");
  });

  test("--llm without --yes → AD_CONFIRMATION_REQUIRED, nothing POSTed; flags required", async () => {
    wireCreate();
    const r = await runCommand(createCommand, ["--category", "Test-Parth", "--spec", file(spec)], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(ff!.requests.filter((q) => q.method === "POST")).toHaveLength(0);
    // No --category and no spec.category (read from the spec file, Stage 7.3).
    expect((await runCommand(createCommand, ["--spec", file(spec), "--yes"], { env: "t-dev" })).envelope?.error?.code).toBe("MISSING_CATEGORY");
    expect((await runCommand(createCommand, ["--category", "x"], { env: "t-dev" })).envelope?.error?.code).toBe("MISSING_SPEC");
  });
});

describe("ad delete", () => {
  const D = "40b7959fb1dd8b4cf2ee9f5e54630ea8"; // DRAFT, referenceId null
  function wireDelete(mutate: (b: V2MethodResponse) => void = () => {}) {
    env();
    let deleted = false;
    ff = fakeFetch([
      {
        method: "GET",
        url: `/rest/api/automation/chain/v2/${D}?basicInfo=false`,
        response: () => {
          if (deleted) return respond({ status: 400, json: { errorMessage: 'Cannot invoke "…getId()" because "automationAPI" is null' } });
          const b = real(D);
          mutate(b);
          return b;
        },
      },
      {
        method: "DELETE",
        url: `/rest/api/automation/chain/v2/${D}`,
        response: () => {
          deleted = true;
          return respond({ status: 204 });
        },
      },
      { method: "POST", url: /cache\/invalidate$/, response: "success" },
    ]).install();
  }
  const deletes = () => ff!.requests.filter((q) => q.method === "DELETE");

  test("never-published draft: DELETE, verified by the V2 re-read (METHOD_NOT_FOUND)", async () => {
    wireDelete();
    const r = await runCommand(deleteCommand, [D, "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope!.data).toEqual({ uuid: D, name: "notification.setting.getList", deleted: true, verified: true });
    expect(deletes()).toHaveLength(1);
    expect(ff!.requests.find((q) => q.url.endsWith("cache/invalidate"))!.json()).toEqual({ uuids: [D], type: "AUTOMATION" });
  });

  test("PUBLISHED → AD_DELETE_PUBLISHED; draft with a published version → AD_DELETE_HAS_PUBLISHED", async () => {
    wireDelete((b) => (b.metadata.state = "PUBLISHED"));
    expect((await runCommand(deleteCommand, [D, "--yes"], { env: "t-dev" })).envelope?.error?.code).toBe("AD_DELETE_PUBLISHED");
    expect(deletes()).toHaveLength(0);
    ff!.restore();
    cfg!.restore();
    wireDelete((b) => (b.metadata.referenceId = "0000000000000000000000000000beef    "));
    expect((await runCommand(deleteCommand, [D, "--yes"], { env: "t-dev" })).envelope?.error?.code).toBe("AD_DELETE_HAS_PUBLISHED");
    expect(deletes()).toHaveLength(0);
  });

  test("missing state → fail closed; --llm without --yes → confirmation required", async () => {
    wireDelete((b) => delete (b.metadata as any).state);
    expect((await runCommand(deleteCommand, [D, "--yes"], { env: "t-dev" })).envelope?.error?.code).toBe("AD_DRAFT_GUARD_STATE_UNKNOWN");
    ff!.restore();
    cfg!.restore();
    wireDelete();
    expect((await runCommand(deleteCommand, [D], { env: "t-dev" })).envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(deletes()).toHaveLength(0);
  });
});
