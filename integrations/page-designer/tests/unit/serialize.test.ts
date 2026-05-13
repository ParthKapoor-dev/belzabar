import { describe, test, expect } from "bun:test";
import { parsePage } from "../../lib/parser/index";
import {
  applyOverlay,
  hydratedToInnerConfig,
  overlayRequiresFullSave,
  overlayToPartialOperations,
  pickStrategy,
  serialize,
  serializeFull,
} from "../../lib/serialize/index";
import type { Overlay } from "../../lib/types/common";
import type { RawPageResponse } from "../../lib/types/wire";

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

// ---------------------------------------------------------------------------
// Round-trip: parse → serializeFull → parse → shape identical in meaningful bits
// ---------------------------------------------------------------------------

describe("serializeFull round-trip", () => {
  test("parse → serializeFull → parse preserves variables, derived, layout shape", () => {
    const raw = wrap(
      rootInner(
        {
          variables: {
            generated: [],
            userDefined: [
              { name: "v1", type: "String", initialValue: "x", translateInitialValue: false, __LAYOUT_CONFIG_METADATA: {} },
              { name: "v2", type: "Any", initialValue: null, translateInitialValue: false, __LAYOUT_CONFIG_METADATA: {} },
            ],
            derived: [{ name: "d1", from: ["v1"], spec: "(function(p){return p.v1;})", filterFn: null, sideEffect: false }],
          },
        },
      ),
    );
    const a = parsePage(raw);
    const configStr = serializeFull(a);
    const reparsed = parsePage({ ...raw, configuration: configStr });

    expect(reparsed.variables.map((v) => v.name)).toEqual(a.variables.map((v) => v.name));
    expect(reparsed.derived.map((d) => d.name)).toEqual(a.derived.map((d) => d.name));
    expect(reparsed.layout.nodeId).toBe(a.layout.nodeId);
    expect(reparsed.__version).toBe(5);
  });

  test("legacy context.properties is migrated to variables.userDefined on serialize", () => {
    const raw = wrap({
      context: { properties: [["legacy", "value"]] },
      layout: rootInner().layout,
      styles: "",
    });
    const a = parsePage(raw);
    const configStr = serializeFull(a);
    const parsedInner = JSON.parse(configStr);
    expect(parsedInner.context).toBeUndefined();
    expect(parsedInner.variables.userDefined[0].name).toBe("legacy");
  });

  test("symbol config preserves inputs/events/helpText on round-trip", () => {
    const raw = wrap({
      __version: 5,
      inputs: ["propA", "propB"],
      events: ["eventX"],
      helpText: { foo: "bar" },
      layout: { id: "__r", name: "div", isSymbol: true, props: { layout: { type: "flex" } }, children: [] },
      styles: "",
      variables: { generated: [], userDefined: [], derived: [] },
      httpRequests: { generated: [], userDefined: [] },
    });
    const a = parsePage(raw);
    const reparsed = parsePage({ ...raw, configuration: serializeFull(a) });
    expect(reparsed.entityType).toBe("COMPONENT");
    expect(reparsed.inputs).toEqual(["propA", "propB"]);
    expect(reparsed.events).toEqual(["eventX"]);
    expect(reparsed.helpText).toEqual({ foo: "bar" });
  });
});

// ---------------------------------------------------------------------------
// overlayToPartialOperations
// ---------------------------------------------------------------------------

describe("overlayToPartialOperations", () => {
  test("variables.update produces UPDATE at variables.userDefined[n].initialValue", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const overlay: Overlay = {
      variables: { update: [{ name: "greeting", initialValue: "hello" }] },
    };
    const ops = overlayToPartialOperations(page, overlay);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      key: "variables.userDefined[0].initialValue",
      value: "hello",
      operation: "UPDATE",
      dataType: "STRING",
    });
  });

  test("variables.update with unknown name → no op (silently skipped)", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const overlay: Overlay = {
      variables: { update: [{ name: "nonExistent", initialValue: "x" }] },
    };
    const ops = overlayToPartialOperations(page, overlay);
    expect(ops).toEqual([]);
  });

  test("httpRequests.update produces per-field UPDATE ops against matching callId", () => {
    const raw = wrap(
      rootInner({
        httpRequests: {
          generated: [],
          userDefined: [
            {
              meta: { serviceCall: { label: "Fetch", callId: "sc-001" } },
              handler: { success: [], error: [], inProgress: "" },
              request: { url: "/x", body: "{}", method: "POST" },
              trigger: [],
            },
          ],
        },
      }),
    );
    const page = parsePage(raw);
    const overlay: Overlay = {
      httpRequests: {
        update: [{ callId: "sc-001", request: { body: "{\"new\":true}", url: "/new" } }],
      },
    };
    const ops = overlayToPartialOperations(page, overlay);
    expect(ops).toEqual([
      { key: "httpRequests.userDefined[0].request.body", value: "{\"new\":true}", operation: "UPDATE", dataType: "STRING" },
      { key: "httpRequests.userDefined[0].request.url", value: "/new", operation: "UPDATE", dataType: "STRING" },
    ]);
  });

  test("elements.operations pass through verbatim (with stringified value)", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const overlay: Overlay = {
      elements: {
        operations: [
          { key: "layout.children[0].props.innerHTML", value: "Hi", operation: "UPDATE", dataType: "STRING" },
          { key: "layout.props.className", value: "scope-x", operation: "UPDATE", dataType: "STRING" },
        ],
      },
    };
    const ops = overlayToPartialOperations(page, overlay);
    expect(ops).toEqual(overlay.elements!.operations.map((op) => ({
      key: op.key,
      value: op.value,
      operation: op.operation,
      dataType: op.dataType,
    })));
  });

  test("styles.replace produces single UPDATE at key `styles`", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const overlay: Overlay = { styles: { replace: ".latest-version .x { color: red }" } };
    const ops = overlayToPartialOperations(page, overlay);
    expect(ops).toEqual([
      { key: "styles", value: ".latest-version .x { color: red }", operation: "UPDATE", dataType: "STRING" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Strategy picker + overlayRequiresFullSave
// ---------------------------------------------------------------------------

describe("pickStrategy / overlayRequiresFullSave", () => {
  test("partial when overlay only updates scalars", () => {
    const overlay: Overlay = { variables: { update: [{ name: "x", initialValue: "y" }] } };
    expect(pickStrategy(overlay)).toBe("partial");
    expect(overlayRequiresFullSave(overlay)).toBe(false);
  });

  test("full when overlay adds variables", () => {
    const overlay: Overlay = { variables: { add: [{ name: "new" }] } };
    expect(pickStrategy(overlay)).toBe("full");
  });

  test("full when overlay removes httpRequests", () => {
    const overlay: Overlay = { httpRequests: { remove: ["sc-001"] } };
    expect(pickStrategy(overlay)).toBe("full");
  });

  test("full when overlay touches derived variables", () => {
    const overlay: Overlay = { derived: { update: [{ name: "d" }] } };
    expect(pickStrategy(overlay)).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// applyOverlay
// ---------------------------------------------------------------------------

describe("applyOverlay", () => {
  test("variables.update changes initialValue in returned HydratedPage (pure — no network)", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const patched = applyOverlay(page, {
      variables: { update: [{ name: "greeting", initialValue: "updated" }] },
    });
    const updated = patched.variables.find((v) => v.name === "greeting");
    expect(updated?.initialValue).toBe("updated");
    // original is untouched
    expect(page.variables.find((v) => v.name === "greeting")?.initialValue).toBe("hi");
  });

  test("variables.add appends a new variable", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const patched = applyOverlay(page, {
      variables: { add: [{ name: "added", type: "Boolean", initialValue: false }] },
    });
    expect(patched.variables.map((v) => v.name)).toEqual(["greeting", "added"]);
  });

  test("variables.remove drops the entry", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const patched = applyOverlay(page, { variables: { remove: ["greeting"] } });
    expect(patched.variables).toEqual([]);
  });

  test("elements.operations UPDATE on layout prop mutates the rebuilt layout", () => {
    const raw = wrap(
      rootInner({}, {
        children: [{ id: "leaf", name: "div", props: { innerHTML: "old" } }],
      }),
    );
    const page = parsePage(raw);
    const patched = applyOverlay(page, {
      elements: {
        operations: [
          { key: "layout.children[0].props.innerHTML", value: "new", operation: "UPDATE", dataType: "STRING" },
        ],
      },
    });
    const leaf = patched.layout.children[0];
    expect(leaf?.props.innerHTML).toBe("new");
  });

  test("styles.replace mutates styles", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const patched = applyOverlay(page, { styles: { replace: "body { color: blue }" } });
    expect(patched.styles).toBe("body { color: blue }");
  });
});

// ---------------------------------------------------------------------------
// serialize() end-to-end
// ---------------------------------------------------------------------------

describe("serialize (strategy dispatch)", () => {
  test("partial strategy emits only the targeted ops", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const result = serialize(page, {
      variables: { update: [{ name: "greeting", initialValue: "hola" }] },
    });
    expect(result.strategy).toBe("partial");
    if (result.strategy !== "partial") throw new Error("strategy");
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.key).toBe("variables.userDefined[0].initialValue");
  });

  test("full strategy emits configurationString matching applyOverlay result", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const result = serialize(page, { variables: { add: [{ name: "added", type: "String" }] } });
    expect(result.strategy).toBe("full");
    if (result.strategy !== "full") throw new Error("strategy");
    const parsedInner = JSON.parse(result.configurationString);
    expect(parsedInner.variables.userDefined.map((v: any) => v.name)).toContain("added");
  });

  test("forced full strategy overrides picker", () => {
    const raw = wrap(rootInner());
    const page = parsePage(raw);
    const result = serialize(
      page,
      { variables: { update: [{ name: "greeting", initialValue: "v" }] } },
      "full",
    );
    expect(result.strategy).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// hydratedToInnerConfig preserves unknown fields
// ---------------------------------------------------------------------------

describe("hydratedToInnerConfig preserves unmodelled fields", () => {
  test("unknown top-level key survives a round-trip", () => {
    const raw = wrap({
      ...rootInner(),
      customExtraKey: { nested: { value: 42 } },
    });
    const page = parsePage(raw);
    const back = hydratedToInnerConfig(page);
    expect((back as any).customExtraKey).toEqual({ nested: { value: 42 } });
  });
});
