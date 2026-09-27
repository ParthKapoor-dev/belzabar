// ad export takes a uuid (F12/AD-31), ad import recognises belz's export
// shapes (F13), ad child-info reports not-found (F23).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { runCommand, withTempEnvConfig } from "@belzabar/core/testing";
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
    const body = { chainDefinitions: [def("a"), def("b")] };
    const dir = mkdtempSync(join(process.env.BELZ_HOME ?? "/tmp", "imp-"));
    const file = join(dir, "export.json");
    writeFileSync(file, JSON.stringify({ ok: true, data: { preview: body } }));
    const imp = spyOn(adApi, "importMethods").mockResolvedValue({ ok: 1 });
    spies.push(imp);
    const r = await runCommand(importCommand, [file, "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(imp.mock.calls[0]![0]).toEqual(body);
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
