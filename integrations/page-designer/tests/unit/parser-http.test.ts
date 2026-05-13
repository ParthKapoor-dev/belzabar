import { describe, test, expect } from "bun:test";
import { parseHttpRequests } from "../../lib/parser/http";
import type { RawConfiguration, RawHttpRequestItem } from "../../lib/types/wire";

function buildItem(over: Partial<RawHttpRequestItem> = {}): RawHttpRequestItem {
  return {
    meta: { serviceCall: { label: "Fetch", callId: "sc-001", serviceUuid: "uuid-1" } },
    handler: {
      success: [["{%items%}", "get('$bodyJson.items')"]],
      error: [],
      inProgress: "{%loading%}",
    },
    request: {
      url: "/rest/api/automation/chain/execute/abcdef1234",
      method: "POST",
      body: "{}",
    },
    trigger: ["this.onInit"],
    ...over,
  };
}

describe("parseHttpRequests", () => {
  test("strips {% %} wrappers on outputs + inProgress", () => {
    const config: RawConfiguration = { httpRequests: { userDefined: [buildItem()] } };
    const [call] = parseHttpRequests(config);
    expect(call).toBeDefined();
    expect(call!.label).toBe("Fetch");
    expect(call!.successMappings).toEqual([{ variable: "items", expression: "get('$bodyJson.items')" }]);
    expect(call!.inProgressVar).toBe("loading");
  });

  test("triggers lose leading 'this.'", () => {
    const config: RawConfiguration = { httpRequests: { userDefined: [buildItem()] } };
    const [call] = parseHttpRequests(config);
    expect(call!.triggers).toEqual(["onInit"]);
  });

  test("extracts AD method id from URL", () => {
    const config: RawConfiguration = { httpRequests: { userDefined: [buildItem()] } };
    const [call] = parseHttpRequests(config);
    expect(call!.adId).toBe("abcdef1234");
  });

  test("eventMeta empty-object detection", () => {
    const config: RawConfiguration = {
      httpRequests: {
        userDefined: [
          buildItem({
            meta: { serviceCall: { label: "x", callId: "y", eventMeta: {} } },
          }),
        ],
      },
    };
    const [call] = parseHttpRequests(config);
    expect(call!.hasEventMeta).toBe(true);
    expect(call!.eventMetaEmpty).toBe(true);
  });

  test("legacy `http` array also parsed (tagged source='legacy')", () => {
    const config: RawConfiguration = { http: [buildItem()] };
    const [call] = parseHttpRequests(config);
    expect(call!.source).toBe("legacy");
  });

  test("generated + userDefined + legacy preserve order and tag source", () => {
    const config: RawConfiguration = {
      httpRequests: {
        generated: [buildItem({ meta: { serviceCall: { label: "g", callId: "g1" } } })],
        userDefined: [buildItem({ meta: { serviceCall: { label: "u", callId: "u1" } } })],
      },
      http: [buildItem({ meta: { serviceCall: { label: "l", callId: "l1" } } })],
    };
    const calls = parseHttpRequests(config);
    expect(calls.map((c) => [c.source, c.label])).toEqual([
      ["generated", "g"],
      ["userDefined", "u"],
      ["legacy", "l"],
    ]);
    expect(calls.map((c) => c.index)).toEqual([1, 2, 3]);
  });
});
