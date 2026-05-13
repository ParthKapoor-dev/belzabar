import { describe, expect, test } from "bun:test";
import { parseV1Step } from "../../lib/parser/steps/v1";
import type { V1ServiceStep } from "../../lib/types/v1-wire";

async function loadStep(name: string): Promise<V1ServiceStep> {
  const file = Bun.file(`${import.meta.dir}/../fixtures/v1/${name}`);
  return (await file.json()) as V1ServiceStep;
}

async function parse(name: string) {
  const raw = await loadStep(name);
  const warnings: string[] = [];
  const step = parseV1Step(raw, raw.orderIndex, w => warnings.push(w));
  return { raw, step, warnings };
}

describe("parseV1Step — CUSTOM_CODE", () => {
  test("JavaScript step: base64 is decoded and fields are typed", async () => {
    const { step, raw, warnings } = await parse("step-custom-code-js.json");
    expect(step.kind).toBe("CUSTOM_CODE");
    if (step.kind !== "CUSTOM_CODE") throw new Error("kind");
    expect(step.language).toBe("JAVASCRIPT");
    expect(step.customCodeEnv).toBe("CODE_LAMBDA");
    expect(step.sourceEncoding).toBe("BASE_64");
    expect(step.source).toContain("var x = 1;");
    expect(step.source).toContain("JSON.stringify(output)");
    expect(step.outputs.length).toBe(2);
    expect(step.outputs[0]!.code).toBe("sum");
    expect(step.outputs[1]!.code).toBe("product");
    expect(step.raw).toBe(raw);
    expect(warnings.length).toBe(0);
  });

  test("Python step: base64 is decoded", async () => {
    const { step } = await parse("step-custom-code-py.json");
    if (step.kind !== "CUSTOM_CODE") throw new Error("kind");
    expect(step.language).toBe("PYTHON");
    expect(step.source).toContain("float");
    expect(step.source).toContain("json.dumps");
  });
});

describe("parseV1Step — SPEL_ECHO", () => {
  test("Echo step: expression is extracted from first mapping", async () => {
    const { step } = await parse("step-spel-echo.json");
    expect(step.kind).toBe("SPEL_ECHO");
    if (step.kind !== "SPEL_ECHO") throw new Error("kind");
    expect(step.expression).toBe("#{firstName + ' ' + lastName}");
  });
});

describe("parseV1Step — SQL", () => {
  test("SQL read: base64 is decoded and result shape extracted", async () => {
    const { step } = await parse("step-sql-read-base64.json");
    expect(step.kind).toBe("SQL");
    if (step.kind !== "SQL") throw new Error("kind");
    expect(step.operation).toBe("read");
    expect(step.sql).toBe("SELECT id, username, email FROM users WHERE org_id = #{orgId}");
    expect(step.sqlEncoding).toBe("BASE_64");
    expect(step.resultShape).toBe("OBJECT");
    expect(step.automationAuthId).toBe(274);
    expect(step.testAccountId).toBe(274);
  });
});

describe("parseV1Step — REDIS", () => {
  test("Redis GET", async () => {
    const { step } = await parse("step-redis-get.json");
    expect(step.kind).toBe("REDIS_GET");
    if (step.kind !== "REDIS_GET") throw new Error("kind");
    expect(step.key).toBe("user:#{userId}");
  });

  test("Redis SET with TTL and overwrite", async () => {
    const { step } = await parse("step-redis-set.json");
    expect(step.kind).toBe("REDIS_SET");
    if (step.kind !== "REDIS_SET") throw new Error("kind");
    expect(step.key).toBe("user:#{userId}");
    expect(step.value).toBe("#{userPayload}");
    expect(step.ttlSeconds).toBe("300");
    expect(step.overwrite).toBe("true");
    expect(step.store).toBe("PERSISTENT");
  });

  test("Redis REMOVE", async () => {
    const { step } = await parse("step-redis-remove.json");
    expect(step.kind).toBe("REDIS_REMOVE");
    if (step.kind !== "REDIS_REMOVE") throw new Error("kind");
    expect(step.key).toBe("user:#{userId}");
  });
});

describe("parseV1Step — EXISTING_SERVICE fallback", () => {
  test("generic existingService step with unknown apiId", async () => {
    const { step } = await parse("step-existing-service-generic.json");
    expect(step.kind).toBe("EXISTING_SERVICE");
    expect(step.automationApiId).toBe(18721);
  });
});

describe("parseV1Step — conditional execution", () => {
  test("advance-mode conditionExpression is preserved", async () => {
    const { step } = await parse("step-with-condition.json");
    expect(step.conditionMode).toBe("advance");
    expect(step.conditionExpression).toBe("#{cacheResult.found} eq false");
  });
});

describe("parseV1Step — loop", () => {
  test("repeatStepExecution and loop source preserved", async () => {
    const { step } = await parse("step-with-repeat.json");
    expect(step.repeatStepExecution).toBe(true);
    expect(step.loopExecutionSource).toBe("#{userList}");
    expect(step.loopConfiguration?.executeParallel).toBe(false);
  });
});

describe("parseV1Step — UNKNOWN fallback", () => {
  test("steps with neither activeTab nor apiId parse to UNKNOWN with a reason", async () => {
    const { step } = await parse("step-unknown-type.json");
    expect(step.kind).toBe("UNKNOWN");
    if (step.kind !== "UNKNOWN") throw new Error("kind");
    expect(step.reason).toContain("no activeTab");
  });
});

describe("parseV1Step — raw preservation", () => {
  test("every parsed step preserves its raw wire JSON verbatim", async () => {
    const fixtures = [
      "step-custom-code-js.json",
      "step-spel-echo.json",
      "step-sql-read-base64.json",
      "step-redis-get.json",
      "step-existing-service-generic.json",
    ];
    for (const name of fixtures) {
      const { step, raw } = await parse(name);
      expect(step.raw).toBe(raw);
    }
  });
});
