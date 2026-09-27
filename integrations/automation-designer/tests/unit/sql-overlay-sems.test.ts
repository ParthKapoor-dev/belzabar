// AD-02 on the write path: a sems-dev db_service step (lean V1 step: only a
// numeric automationId) is classified SQL once its service is resolved, so
// `ad save` accepts a `sql` overlay and writes it into the query slot the
// parser read — plain text stays plain, nothing else changes.
import { describe, expect, test } from "bun:test";
import { buildGuardedV1SavePayload } from "../../lib/serialize/guard";
import { parseV1Method } from "../../lib/parser/v1";
import { buildServiceResolver } from "../../lib/hydrator";
import type { V1AutomationDefinition, V1RawMethodResponse } from "../../lib/types/v1-wire";
import type { SqlStep } from "../../lib/types/common";

const FIX = `${import.meta.dir}/../fixtures`;
const UUID = "41bb1b438875bd8b994196db1f12b7c2"; // step 1 = db_service data.read (automationId 1040)

async function load() {
  const raw = (await Bun.file(`${FIX}/real-v1/${UUID}.v1.json`).json()) as V1RawMethodResponse;
  const def1040 = (await Bun.file(`${FIX}/definitions/1040.json`).json()) as V1AutomationDefinition;
  const { resolveService } = await buildServiceResolver(raw, {
    getDefinition: async (id) => (id === "1040" ? def1040 : null),
  });
  return { raw, resolveService };
}

describe("sql overlay on a sems-dev db_service step (AD-02)", () => {
  test("classified SQL with the plain-text query decoded", async () => {
    const { raw, resolveService } = await load();
    const m = parseV1Method(raw, { env: "sems-dev", resolveService });
    const step = m.parsedSteps.find((s) => s.orderIndex === 1) as SqlStep;
    expect(step.kind).toBe("SQL");
    expect(step.serviceName).toBe("db_service");
    expect(step.methodName).toBe("data.read");
    expect(step.sqlEncoding).toBe("NONE");
    expect(step.sql).toBe("select * from enrollment_stage_type where code = '#{code}';");
  });

  test("guard accepts the overlay and writes only the queryString mapping, in plain text", async () => {
    const { raw, resolveService } = await load();
    const m = parseV1Method(raw, { env: "sems-dev", resolveService });
    const next = "select id, code from enrollment_stage_type where code = '#{code}';";
    const { payload, applied } = buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, sql: next }] });
    expect(applied).toEqual(["parsedSteps[orderIndex=1].sql"]);

    const before = JSON.parse(raw.jsonDefinition);
    const after = JSON.parse(payload.jsonDefinition);
    expect(after.services[0].mappings[0].mappings[0].value).toBe(next);
    after.services[0].mappings[0].mappings[0].value = before.services[0].mappings[0].mappings[0].value;
    expect(after).toEqual(before);
  });

  test("unresolved (no lookup, no env) the step stays EXISTING_SERVICE and the overlay is refused", async () => {
    const { raw } = await load();
    const m = parseV1Method(raw);
    expect(m.parsedSteps[0]!.kind).toBe("EXISTING_SERVICE");
    expect(() => buildGuardedV1SavePayload(m, { parsedSteps: [{ orderIndex: 1, sql: "select 1" }] })).toThrow(
      expect.objectContaining({ code: "AD_OVERLAY_NOT_APPLIED" }),
    );
  });
});
