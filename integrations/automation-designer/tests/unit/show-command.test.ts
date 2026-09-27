// `ad show`: canonical uuid from any spelling (AD-30/F11), identity is always
// a string (F37), step inputs + basic conditions are rendered (AD-40), and SQL
// on sems shows once the step is classified (AD-02).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import showCommand, { flattenStepInputs, identityForStep } from "../../commands/show/index";
import { adApi } from "../../lib/api/index";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { parseV1Method } from "../../lib/parser/v1";
import { parseV2Method } from "../../lib/parser/v2";
import type { V1AutomationDefinition, V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import type { ParsedStep } from "../../lib/types/common";

const FIX = `${import.meta.dir}/../fixtures`;
const UUID = "41bb1b438875bd8b994196db1f12b7c2";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

async function v2Method() {
  return parseV2Method((await Bun.file(`${FIX}/real-v2/${UUID}.v2.json`).json()) as V2MethodResponse, { env: "sems-dev" });
}

describe("identityForStep (F37)", () => {
  test("always a string, whatever the wire types", () => {
    const base = { orderIndex: 1, outputs: [], inputs: [], raw: {}, kind: "EXISTING_SERVICE" } as const;
    expect(identityForStep({ ...base, serviceName: "db_service", methodName: "data.read" } as ParsedStep)).toBe("db_service.data.read");
    expect(identityForStep({ ...base, automationApiId: 4184 } as ParsedStep)).toBe("apiId:4184");
    expect(identityForStep({ ...base, automationId: 3319 as unknown as string } as ParsedStep)).toBe("automationId:3319");
    expect(identityForStep({ ...base } as ParsedStep)).toBe("");
  });
});

describe("flattenStepInputs (AD-40)", () => {
  test("V2 db_service inputs flatten to body.queryString", async () => {
    const m = await v2Method();
    const rows = flattenStepInputs(m.parsedSteps[0]!.inputs);
    expect(rows).toContainEqual({ input: "body.queryString", value: "select * from enrollment_stage_type where code = '#{code}';" });
  });

  test("V1 inputs use definition labels when available", async () => {
    const raw = (await Bun.file(`${FIX}/real-v1/${UUID}.v1.json`).json()) as V1RawMethodResponse;
    const def = (await Bun.file(`${FIX}/definitions/1040.json`).json()) as V1AutomationDefinition;
    const m = parseV1Method(raw);
    const rows = flattenStepInputs(m.parsedSteps[0]!.inputs, (i) =>
      i.automationUserInputId != null ? ServiceHydrator.findInputLabel(def, i.automationUserInputId)?.label : undefined,
    );
    expect(rows[0]!.input).toMatch(/SQLQuery$/);
    expect(rows[0]!.value).toContain("enrollment_stage_type");
    // Basic-mode condition rows are parsed alongside the expression.
    expect(m.parsedSteps[0]!.conditionRows).toEqual([{ field: "code", operator: "ne", value: "null" }]);
  });
});

describe("ad show command", () => {
  function stub(method: Awaited<ReturnType<typeof v2Method>>) {
    const fetch = spyOn(adApi, "fetchMethod").mockResolvedValue(method);
    spies.push(
      fetch,
      spyOn(CacheManager, "loadSwr").mockResolvedValue(null),
      spyOn(CacheManager, "save").mockResolvedValue(undefined),
    );
    return fetch;
  }

  test("an AD URL / padded / upper-case uuid is fetched as the canonical uuid", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const fetch = stub(await v2Method());
    for (const input of [`https://t.test/automation-designer/Schools/${UUID}`, `${UUID.toUpperCase()}    `]) {
      const r = await runCommand(showCommand, [input, "--v2"], { env: "t-dev" });
      expect(r.envelope?.ok).toBe(true);
      expect((r.envelope?.data as any).request.uuid).toBe(UUID);
    }
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([UUID, UUID]);
  });

  test("invalid uuid → INVALID_UUID, nothing fetched", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const fetch = stub(await v2Method());
    const r = await runCommand(showCommand, ["not-a-uuid"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("INVALID_UUID");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("--sql shows the decoded SQL, step inputs and string identities; editUrl uses the uuid (AD-35)", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stub(await v2Method());
    const r = await runCommand(showCommand, [UUID, "--v2", "--sql"], { env: "t-dev" });
    const data = r.envelope?.data as any;
    expect(data.summary.editUrl.endsWith(`/${UUID}`)).toBe(true);
    for (const s of data.steps) expect(typeof s.identity).toBe("string");
    const first = data.allStepDetails[0];
    expect(first.kind).toBe("SQL");
    expect(first.identity).toBe("db_service.data.read");
    expect(first.sql).toContain("enrollment_stage_type");
    const svc = data.allStepDetails.find((d: any) => d.kind === "EXISTING_SERVICE");
    expect(Array.isArray(svc.inputs)).toBe(true);
  });
});
