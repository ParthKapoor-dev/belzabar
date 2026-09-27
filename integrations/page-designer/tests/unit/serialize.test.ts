// Serializer: applyOverlay (raw-config edit), partial ops (raw indices, full
// coverage), planSave strategy, full save losslessness.
// Bugs: PD-2 (raw indices), PD-3 (handler/transform ops), PD-22 (lossless).
import { describe, test, expect } from "bun:test";
import { parsePage } from "../../lib/parser/index";
import {
  applyOverlay,
  fullSaveReason,
  partialOperationsFor,
  planSave,
  replayOperations,
  serializeFull,
} from "../../lib/serialize/index";
import type { HydratedPage, Overlay } from "../../lib/types/common";
import type { RawConfiguration, RawPageResponse } from "../../lib/types/wire";

function wrap(inner: unknown): RawPageResponse {
  return { id: "p1", name: "p1", status: "DRAFT", configuration: JSON.stringify(inner) };
}

function rootInner(over: Record<string, unknown> = {}, rootOver: Record<string, unknown> = {}) {
  return {
    __version: 5,
    layout: {
      id: "__root",
      name: "div",
      props: { layout: { type: "flex" } },
      children: [],
      _elementId: "__er",
      unSelectable: true,
      __LAYOUT_CONFIG_METADATA: {},
      ...rootOver,
    },
    styles: "",
    variables: {
      generated: [],
      userDefined: [{ name: "greeting", type: "String", initialValue: "hi", translateInitialValue: false, __LAYOUT_CONFIG_METADATA: {} }],
      derived: [],
    },
    httpRequests: { generated: [], userDefined: [] },
    ...over,
  };
}

const call = (callId: string, extra: Record<string, unknown> = {}) => ({
  meta: { serviceCall: { label: callId, callId } },
  handler: { success: [], error: [], inProgress: "" },
  request: { url: "/x", body: "{}", method: "POST" },
  trigger: [],
  ...extra,
});

const inner = (p: HydratedPage) => p.rawConfiguration as RawConfiguration;

describe("serializeFull is lossless (PD-22)", () => {
  test("duplicate vars, null type, legacy format, inputs/events survive untouched", () => {
    const cfg = {
      __version: 5,
      inputs: ["a"],
      events: ["e"],
      context: { properties: [["legacy", "value"]] },
      http: [call("legacy-call")],
      layout: rootInner().layout,
      variables: {
        userDefined: [
          { name: "a", type: null, initialValue: null },
          { name: "a", type: "String", initialValue: "dup" },
        ],
      },
      customExtraKey: { nested: { value: 42 } },
    };
    const page = parsePage(wrap(cfg));
    expect(JSON.parse(serializeFull(page))).toEqual(cfg);
  });

  test("a page's inputs/events survive (they used to be deleted on pages)", () => {
    const cfg = rootInner({ inputs: ["x"], events: ["y"] });
    expect(JSON.parse(serializeFull(parsePage(wrap(cfg))))).toEqual(cfg);
  });
});

describe("applyOverlay", () => {
  test("variables.update changes only that entry (pure — original untouched)", () => {
    const page = parsePage(wrap(rootInner()));
    const patched = applyOverlay(page, { variables: { update: [{ name: "greeting", initialValue: "updated" }] } });
    expect(patched.variables.find((v) => v.name === "greeting")?.initialValue).toBe("updated");
    expect(page.variables.find((v) => v.name === "greeting")?.initialValue).toBe("hi");
    const expected = rootInner();
    expected.variables.userDefined[0]!.initialValue = "updated";
    expect(inner(patched)).toEqual(expected);
  });

  test("variables.add / remove", () => {
    const page = parsePage(wrap(rootInner()));
    expect(applyOverlay(page, { variables: { add: [{ name: "added", type: "Boolean", initialValue: false }] } }).variables.map((v) => v.name)).toEqual([
      "greeting",
      "added",
    ]);
    expect(applyOverlay(page, { variables: { remove: ["greeting"] } }).variables).toEqual([]);
  });

  test("unknown targets are refused with PD_OVERLAY_INVALID (not silently skipped)", () => {
    const page = parsePage(wrap(rootInner({ httpRequests: { generated: [], userDefined: [call("sc-1")] } })));
    const bad: Overlay[] = [
      { variables: { update: [{ name: "nope", initialValue: 1 }] } },
      { variables: { remove: ["nope"] } },
      { variables: { add: [{ name: "greeting" }] } },
      { derived: { update: [{ name: "nope", spec: "x" }] } },
      { httpRequests: { update: [{ callId: "nope", trigger: [] }] } },
      { httpRequests: { remove: ["nope"] } },
      { elements: { operations: [{ key: "layout.children[3].props.x", value: "v", operation: "UPDATE", dataType: "STRING" }] } },
    ];
    for (const overlay of bad) {
      expect(() => applyOverlay(page, overlay)).toThrow(expect.objectContaining({ code: "PD_OVERLAY_INVALID" }));
    }
  });

  test("derived vars kept in userDefined (real editor shape) are edited in place, and added there", () => {
    const cfg = rootInner({
      variables: {
        generated: [],
        userDefined: [
          { name: "raw", type: "String", initialValue: "x" },
          { name: "d", type: "Any", from: ["raw"], spec: "(function(p){return p.raw})", compileType: "DERIVED", sideEffect: true },
        ],
        derived: [],
      },
    });
    const page = parsePage(wrap(cfg));
    expect(page.variables.map((v) => v.name)).toEqual(["raw"]);
    expect(page.derived.map((d) => [d.name, d.location])).toEqual([["d", "userDefined"]]);
    // variables.update on a derived name points at derived.update
    expect(() => applyOverlay(page, { variables: { update: [{ name: "d", initialValue: 1 }] } })).toThrow(/use derived.update/);

    const patched = applyOverlay(page, {
      derived: { update: [{ name: "d", spec: "NEW" }], add: [{ name: "d2", from: ["raw"], spec: "S" }] },
    });
    const ud = inner(patched).variables!.userDefined as any[];
    expect(ud[1].spec).toBe("NEW");
    expect(ud[1].compileType).toBe("DERIVED"); // untouched keys stay
    expect(ud[2]).toMatchObject({ name: "d2", from: ["raw"], spec: "S", compileType: "DERIVED" });
    expect(inner(patched).variables!.derived).toEqual([]);
  });

  test("elements UPDATE mutates the layout; styles.replace", () => {
    const page = parsePage(wrap(rootInner({}, { children: [{ id: "leaf", name: "div", props: { innerHTML: "old" } }] })));
    const patched = applyOverlay(page, {
      elements: { operations: [{ key: "layout.children[0].props.innerHTML", value: "new", operation: "UPDATE", dataType: "STRING" }] },
      styles: { replace: "body { color: blue }" },
    });
    expect(patched.layout.children[0]?.props.innerHTML).toBe("new");
    expect(patched.styles).toBe("body { color: blue }");
  });
});

describe("partial operations use RAW indices (PD-2)", () => {
  test("duplicate names before the target: the op points at the raw index", () => {
    const cfg = rootInner({
      variables: {
        generated: [],
        userDefined: [
          { name: "a", type: "String", initialValue: "1" },
          { name: "a", type: "String", initialValue: "2" },
          { name: "b", type: "String", initialValue: "3" },
        ],
        derived: [],
      },
    });
    const page = parsePage(wrap(cfg));
    expect(page.variables.map((v) => v.name)).toEqual(["a", "b"]); // parser de-dupes
    const ops = partialOperationsFor(inner(page), { variables: { update: [{ name: "b", initialValue: "X" }] } });
    expect(ops).toEqual([{ key: "variables.userDefined[2].initialValue", value: "X", operation: "UPDATE", dataType: "STRING" }]);
  });

  test("derived entries interleaved in userDefined count toward the index", () => {
    const cfg = rootInner({
      variables: {
        generated: [],
        userDefined: [
          { name: "d", from: ["x"], spec: "s" },
          { name: "x", type: "Number", initialValue: 1 },
        ],
        derived: [],
      },
    });
    const ops = partialOperationsFor(inner(parsePage(wrap(cfg))), { variables: { update: [{ name: "x", initialValue: 2, type: "Number" }] } });
    expect(ops?.map((o) => [o.key, o.value, o.dataType])).toEqual([
      ["variables.userDefined[1].initialValue", "2", "NUMBER"],
      ["variables.userDefined[1].type", "Number", "STRING"],
    ]);
  });

  test("legacy context.properties pages never get partial ops (full save)", () => {
    const cfg = { context: { properties: [["a", 1]] }, layout: rootInner().layout };
    const page = parsePage(wrap(cfg));
    expect(fullSaveReason({ variables: { update: [{ name: "a", initialValue: 2 }] } }, inner(page))).toBe("legacy context.properties page");
    const plan = planSave(page, { variables: { update: [{ name: "a", initialValue: 2 }] } });
    expect(plan.strategy).toBe("full");
    expect(JSON.parse((plan as any).configurationString)).toEqual({ ...cfg, context: { properties: [["a", 2]] } });
  });
});

describe("httpRequests.update emits every field (PD-3)", () => {
  const cfg = rootInner({ httpRequests: { generated: [call("gen-1")], userDefined: [call("sc-0"), call("sc-1")] } });
  const page = parsePage(wrap(cfg));

  test("request, handler.success/error/inProgress, trigger, triggerFilter, responseTransformSpec", () => {
    const overlay: Overlay = {
      httpRequests: {
        update: [
          {
            callId: "sc-1",
            request: { body: "{\"a\":1}", url: "/new", method: "GET" },
            handler: { success: [["{%x%}", "data"]], error: [["{%err%}", "e"]], inProgress: "{%busy%}" },
            trigger: ["this.x"],
            triggerFilter: "(function(){return true})",
            responseTransformSpec: "(function(d){return d})",
          },
        ],
      },
    };
    const plan = planSave(page, overlay);
    expect(plan.strategy).toBe("partial");
    if (plan.strategy !== "partial") throw new Error("strategy");
    expect(plan.operations.map((o) => [o.key, o.operation, o.dataType])).toEqual([
      ["httpRequests.userDefined[1].request.body", "UPDATE", "STRING"],
      ["httpRequests.userDefined[1].request.url", "UPDATE", "STRING"],
      ["httpRequests.userDefined[1].request.method", "UPDATE", "STRING"],
      ["httpRequests.userDefined[1].handler.success", "UPDATE", "ARRAY"],
      ["httpRequests.userDefined[1].handler.error", "UPDATE", "ARRAY"],
      ["httpRequests.userDefined[1].handler.inProgress", "UPDATE", "STRING"],
      ["httpRequests.userDefined[1].trigger", "UPDATE", "ARRAY"],
      ["httpRequests.userDefined[1].triggerFilter", "CREATE", "STRING"],
      ["httpRequests.userDefined[1].responseTransformSpec", "CREATE", "STRING"],
    ]);
    // the ops, replayed like the server does, reproduce the planned page exactly
    expect(replayOperations(inner(page), plan.operations)).toEqual(inner(plan.patched));
  });

  test("a call in httpRequests.generated is addressed there", () => {
    const ops = partialOperationsFor(inner(page), { httpRequests: { update: [{ callId: "gen-1", trigger: [] }] } });
    expect(ops?.[0]?.key).toBe("httpRequests.generated[0].trigger");
  });

  test("ops that cannot cover the edit (missing parent object) fall back to a full save", () => {
    const noHandler = parsePage(wrap(rootInner({ httpRequests: { generated: [], userDefined: [{ meta: { serviceCall: { callId: "h" } } }] } })));
    const plan = planSave(noHandler, { httpRequests: { update: [{ callId: "h", handler: { error: [] } }] } });
    expect(plan.strategy).toBe("full");
    expect((plan as any).fallbackReason).toBe("partial operations do not cover the overlay");
    expect(JSON.parse((plan as any).configurationString).httpRequests.userDefined[0].handler).toEqual({ error: [] });
  });
});

describe("planSave strategy", () => {
  const page = parsePage(wrap(rootInner()));
  test("partial for scalar updates; value encodings", () => {
    const plan = planSave(page, {
      variables: { update: [{ name: "greeting", initialValue: { a: 1 }, translateInitialValue: true }] },
      styles: { replace: ".x{}" },
      elements: { operations: [{ key: "layout.props.className", value: "c", operation: "CREATE", dataType: "STRING" }] },
    });
    expect(plan.strategy).toBe("partial");
    if (plan.strategy !== "partial") throw new Error("strategy");
    expect(plan.operations).toEqual([
      { key: "variables.userDefined[0].initialValue", value: "{\"a\":1}", operation: "UPDATE", dataType: "OBJECT" },
      { key: "variables.userDefined[0].translateInitialValue", value: "true", operation: "UPDATE", dataType: "BOOLEAN" },
      { key: "layout.props.className", value: "c", operation: "CREATE", dataType: "STRING" },
      { key: "styles", value: ".x{}", operation: "UPDATE", dataType: "STRING" },
    ]);
  });

  test.each<[string, Overlay]>([
    ["variables.add", { variables: { add: [{ name: "n" }] } }],
    ["variables.remove", { variables: { remove: ["greeting"] } }],
    ["httpRequests.add", { httpRequests: { add: [call("new")] } }],
  ])("full for %s, and the full body is the raw config with only the edit applied", (reason, overlay) => {
    const plan = planSave(page, overlay);
    expect(plan.strategy).toBe("full");
    expect((plan as any).fallbackReason).toBe(reason);
    expect(JSON.parse((plan as any).configurationString)).toEqual(inner(plan.patched));
  });
});
