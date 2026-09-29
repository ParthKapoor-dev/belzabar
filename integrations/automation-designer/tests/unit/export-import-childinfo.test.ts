// ad export takes a uuid (F12/AD-31), ad import recognises belz's export
// shapes (F13), ad child-info reports not-found (F23).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CliError } from "@belzabar/core";
import { runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import { golden } from "./validate-fixtures";
import exportCommand from "../../commands/export/index";
import importCommand, { extractMethodNames } from "../../commands/import/index";
import childInfoCommand from "../../commands/child-info/index";
import { adApi } from "../../lib/api/index";

const U = "4bf56e008eabe4010508af439a15ecfb";
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});
const quiet = () => spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));

describe("ad export", () => {
  test("a uuid (any spelling / URL) is resolved to the numeric chain id", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const raw = spyOn(adApi, "fetchRawMethod").mockResolvedValue({ id: 20037, uuid: U } as any);
    const exp = spyOn(adApi, "exportMethod").mockResolvedValue({ chainDefinition: {}, testSuite: null });
    spies.push(raw, exp);
    for (const input of [U, `${U.toUpperCase()}    `, `https://t.test/automation-designer/Test-Parth/${U}`]) {
      const r = await runCommand(exportCommand, [input], { env: "t-dev" });
      expect(r.envelope?.ok).toBe(true);
      expect(r.envelope?.data).toMatchObject({ id: 20037, uuid: U });
    }
    expect(raw.mock.calls.every((c) => c[0] === U && c[1] === "v1")).toBe(true);
    expect(exp.mock.calls.map((c) => c[0])).toEqual([20037, 20037, 20037]);
  });

  test("a numeric id is exported directly (no fetch)", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const raw = spyOn(adApi, "fetchRawMethod").mockResolvedValue({} as any);
    const exp = spyOn(adApi, "exportMethod").mockResolvedValue({});
    spies.push(raw, exp);
    const r = await runCommand(exportCommand, ["98765"], { env: "t-dev" });
    expect(r.envelope?.data).toMatchObject({ id: 98765, uuid: null });
    expect(raw).not.toHaveBeenCalled();
  });

  test("garbage → INVALID_UUID", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const r = await runCommand(exportCommand, ["abc"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("INVALID_UUID");
  });
});

const EXPORT = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/export/method-606.json"), "utf8"));
/** The real `ad export` body (sems-dev chain 606) renamed; uuid dropped unless given. */
function realDef(name: string, uuid?: string): any {
  const d = structuredClone(EXPORT);
  d.chainDefinition.name = name;
  d.chainDefinition.aliasName = name;
  if (uuid) d.chainDefinition.uuid = uuid;
  else delete d.chainDefinition.uuid;
  return d;
}
function writeTmp(text: string): string {
  const dir = mkdtempSync(join(process.env.BELZ_HOME ?? "/tmp", "imp-"));
  const file = join(dir, "export.json");
  writeFileSync(file, text);
  return file;
}

describe("ad import: extractMethodNames (F13)", () => {
  const def = (name: string) => ({ chainDefinition: { name, aliasName: name, jsonDefinition: "{}" }, testSuite: null });
  test("ad export shape", () => expect(extractMethodNames(def("a"))).toEqual(["a"]));
  test("ad export-category shape", () =>
    expect(extractMethodNames({ chainDefinitions: [def("a"), def("b")], status: "OK" })).toEqual(["a", "b"]));
  test("--llm envelope around an export", () =>
    expect(extractMethodNames({ ok: true, data: { id: 1, preview: def("a") } })).toEqual(["a"]));
  test("name from jsonDefinition when the record has none", () =>
    expect(extractMethodNames({ chainDefinition: { jsonDefinition: JSON.stringify({ name: "inner" }) } })).toEqual(["inner"]));
  test("legacy list shapes still work", () =>
    expect(extractMethodNames({ methods: [{ name: "x" }, { aliasName: "y" }] })).toEqual(["x", "y"]));

  test("import confirms the real count and posts the unwrapped export body", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    quiet();
    const body = { chainDefinitions: [realDef("a"), realDef("b")] };
    const file = writeTmp(JSON.stringify({ ok: true, data: { preview: body } }));
    const imp = spyOn(adApi, "importMethods").mockResolvedValue({ ok: 1 });
    const fetch = spyOn(adApi, "fetchMethod").mockRejectedValue(new CliError("nope", { code: "METHOD_NOT_FOUND" }));
    spies.push(imp, fetch);
    const r = await runCommand(importCommand, [file, "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(imp.mock.calls[0]![0]).toEqual(body);
    expect((r.envelope?.data as any).methods.map((m: any) => [m.name, m.target, m.format])).toEqual([
      ["a", "new", "v1"],
      ["b", "new", "v1"],
    ]);
  });
});

// ADW-R9: nothing unrecognised, malformed or aimed at a PUBLISHED chain is ever sent.
describe("ad import guards (ADW-R9)", () => {
  const run = async (content: unknown, fetchImpl?: (uuid: string) => unknown) => {
    const cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    quiet();
    const imp = spyOn(adApi, "importMethods").mockResolvedValue({ ok: 1 });
    const fetch = spyOn(adApi, "fetchMethod").mockImplementation(async (uuid: string) => {
      const m = fetchImpl?.(uuid);
      if (!m) throw new CliError("nope", { code: "METHOD_NOT_FOUND" });
      return m as any;
    });
    spies.push(imp, fetch);
    try {
      const file = typeof content === "string" && content.startsWith("/") ? content : writeTmp(JSON.stringify(content));
      const r = await runCommand(importCommand, [file, "--yes"], { env: "t-dev" });
      return { r, sent: imp.mock.calls.length };
    } finally {
      cfg.restore();
    }
  };

  test("a missing file → FILE_NOT_FOUND (was UNHANDLED_EXCEPTION)", async () => {
    const { r, sent } = await run("/nonexistent/adw.json");
    expect(r.envelope?.error?.code).toBe("FILE_NOT_FOUND");
    expect(sent).toBe(0);
  });

  test("0 recognised methods → AD_IMPORT_EMPTY, nothing sent (even with --yes)", async () => {
    const { r, sent } = await run({ foo: [1, 2, 3], bar: "unrelated" });
    expect(r.envelope?.error?.code).toBe("AD_IMPORT_EMPTY");
    expect(sent).toBe(0);
  });

  test("a record without a readable definition → AD_IMPORT_INVALID", async () => {
    for (const rec of [
      { name: "x" },
      { chainDefinition: { name: "x", jsonDefinition: "{not json" } },
      { chainDefinition: { name: "x", jsonDefinition: "{}" } },
      { chainDefinition: { name: "x", jsonDefinition: JSON.stringify({ services: [{ orderIndex: 1 }] }) } },
    ]) {
      const { r, sent } = await run(rec);
      expect(r.envelope?.error?.code).toBe("AD_IMPORT_INVALID");
      expect(sent).toBe(0);
    }
  });

  test("a PUBLISHED record, or a uuid that is PUBLISHED on the target → refused", async () => {
    const pubRec = realDef("p");
    pubRec.chainDefinition.automationState = "PUBLISHED";
    let res = await run(pubRec);
    expect(res.r.envelope?.error?.code).toBe("AD_IMPORT_PUBLISHED");
    expect(res.sent).toBe(0);
    res = await run(realDef("d", "4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"), () => ({ state: "PUBLISHED", raw: {} }));
    expect(res.r.envelope?.error?.code).toBe("AD_IMPORT_TARGETS_PUBLISHED");
    expect(res.sent).toBe(0);
    res = await run(realDef("d", "4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"), () => ({ state: "DRAFT", raw: {} }));
    expect(res.r.envelope?.ok).toBe(true);
    expect((res.r.envelope?.data as any).methods[0].target).toBe("existing-draft");
  });

  test("V2 records go through the validator (errors block, nothing sent)", async () => {
    const broken = golden() as any; // `any`: test mutation of the wire body
    broken.outputs.push({ key: "", type: "STRING" });
    delete broken.uuid;
    const { r, sent } = await run({ methods: [broken] });
    expect(r.envelope?.error?.code).toBe("AD_VALIDATION_FAILED");
    expect(sent).toBe(0);
  });
});

describe("ad child-info (F23)", () => {
  test("null body → METHOD_NOT_FOUND, not ok:true", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    spies.push(spyOn(adApi, "fetchChildMethodInfo").mockResolvedValue(null));
    const r = await runCommand(childInfoCommand, ["Schools", "nonexistent.method"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("METHOD_NOT_FOUND");
    expect(r.exitCode).not.toBe(0);
  });

  test("a real body passes through", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    spies.push(spyOn(adApi, "fetchChildMethodInfo").mockResolvedValue({ inputs: [] }));
    const r = await runCommand(childInfoCommand, ["Schools", "x"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
  });
});
