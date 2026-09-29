// parseV2Method smoke tests against REAL acme-dev V2 bodies (the old
// hand-written v2/method-smoke.json put `uuid` under `metadata`, which the
// wire never does — the real body has a top-level `uuid`).
//
// Fixtures (tests/fixtures/real-v2/):
//   486041dfd02d…  DRAFT, Schools-Configure, EXISTING_SERVICE + SPEL_ECHO steps
//   4b108b0554b0…  PUBLISHED (has referenceId), Schools, custom-code step

import { describe, expect, test, beforeAll } from "bun:test";
import { parseV2Method } from "../../lib/parser/index";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { jsonFixtures } from "@belzabar/core/testing";

const FIX = `${import.meta.dir}/../fixtures/real-v2`;
const load = (uuid: string) => jsonFixtures(FIX, ".v2.json")<V2MethodResponse & Record<string, any>>(uuid);

describe("parseV2Method (real wire)", () => {
  let echoRaw: V2MethodResponse & Record<string, any>;
  let ccRaw: V2MethodResponse & Record<string, any>;

  beforeAll(async () => {
    echoRaw = await load("486041dfd02d9fd45a27b608ad2dce0c");
    ccRaw = await load("4b108b0554b0daa963f4bd6985f0de52");
  });

  test("identity fields (state, version, referenceId) come from metadata", () => {
    const draft = parseV2Method(echoRaw);
    expect(draft.sourceVersion).toBe("v2");
    expect(draft.state).toBe("DRAFT");
    expect(draft.version).toBe(2);
    expect(draft.referenceId).toBeNull();

    const pub = parseV2Method(ccRaw);
    expect(pub.state).toBe("PUBLISHED");
    expect(pub.referenceId).toBe("4b6833766e141a259d50bfcd3d606c37");
  });

  test("name and category (service) with uuid", () => {
    const method = parseV2Method(echoRaw);
    expect(method.name).toBe("Copy.configurations.features.download.internal.1");
    expect(method.category).toEqual({ id: 24, uuid: "4700658b809a62a86d4ab58da1ccbda6", name: "Schools-Configure" });
  });

  test("maps inputs and outputs from key/name", () => {
    const method = parseV2Method(echoRaw);
    expect(method.inputs.map((i) => i.code)).toEqual(["featureConfig", "moduleConfigsJson"]);
    expect(method.inputs[0]!.displayName).toBe("featureConfig");
    expect(method.outputs.map((o) => o.code)).toEqual(["moduleConfigsJson1"]);
  });

  test("discriminates step kinds via properties.type and serviceName", () => {
    const echo = parseV2Method(echoRaw);
    expect(echo.parsedSteps.map((s) => s.kind)).toEqual([
      "EXISTING_SERVICE", "SPEL_ECHO", "SQL", "SPEL_ECHO", "SPEL_ECHO",
      "EXISTING_SERVICE", "EXISTING_SERVICE", "EXISTING_SERVICE",
    ]);
    const spel = echo.parsedSteps[1]!;
    if (spel.kind !== "SPEL_ECHO") throw new Error("kind");
    expect(spel.expression).toContain("#{featureConfig.display");

    const cc = parseV2Method(ccRaw).parsedSteps[3]!;
    expect(cc.kind).toBe("CUSTOM_CODE");
    if (cc.kind !== "CUSTOM_CODE") throw new Error("kind");
    expect(cc.language).toBe("JAVASCRIPT");
    expect(cc.sourceEncoding).toBe("NONE");
    expect(cc.source).toContain('let finalText="#{finaltext}"');
  });

  test("real wire pads some ids with trailing spaces and parse still succeeds", () => {
    expect(ccRaw.automationApiId).toMatch(/^[0-9a-f]{32}\s+$/);
    expect(ccRaw.steps![0]!.id as unknown as string).toMatch(/\s+$/);
    expect(() => parseV2Method(ccRaw)).not.toThrow();
  });

  // the uuid is the top-level wire field (metadata has none).
  test("uuid is read from the top-level wire field", () => {
    const method = parseV2Method(echoRaw);
    expect(method.uuid).toBe("486041dfd02d9fd45a27b608ad2dce0c");
    expect(method.parseWarnings).toEqual([]);
  });
});
