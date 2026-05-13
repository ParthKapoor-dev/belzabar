import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePage } from "../../lib/parser/index";
import type { RawPageResponse } from "../../lib/types/wire";

function loadRaw(name: string): RawPageResponse {
  const body = readFileSync(join(__dirname, "fixtures", name), "utf8");
  return JSON.parse(body) as RawPageResponse;
}

describe("parsePage", () => {
  test("minimal page parses into HydratedPage with correct shape", () => {
    const raw = loadRaw("page-minimal.json");
    const page = parsePage(raw);

    expect(page.id).toBe("minimal001");
    expect(page.name).toBe("minimal-page");
    expect(page.entityType).toBe("PAGE");
    expect(page.status).toBe("DRAFT");
    expect(page.versionId).toBe(1);
    expect(page.__version).toBe(5);

    expect(page.variables.map((v) => v.name)).toEqual(["myVar"]);
    expect(page.variables[0]!.type).toBe("String");

    expect(page.layout.kind).toBe("LAYOUT_CONTAINER");
    if (page.layout.kind !== "LAYOUT_CONTAINER") throw new Error("kind");
    expect(page.layout.isRoot).toBe(true);
    expect(page.layout.nodeId).toBe("__node_id_root");

    expect(page.httpRequests).toEqual([]);
    expect(page.inputs).toEqual([]);
    expect(page.events).toEqual([]);
    expect(page.parseWarnings).toEqual([]);
  });

  test("raw fields preserved for round-trip safety", () => {
    const raw = loadRaw("page-minimal.json");
    const page = parsePage(raw);
    expect(page.raw).toBe(raw);
    expect(page.rawConfigurationString).toBe(raw.configuration);
    expect(page.rawConfiguration).toEqual(JSON.parse(raw.configuration!));
  });

  test("empty configuration string produces an empty-root HydratedPage with warning", () => {
    const raw: RawPageResponse = { id: "x", name: "x", status: "DRAFT", configuration: "" };
    const page = parsePage(raw);
    expect(page.parseWarnings.some((w) => w.includes("configuration field is empty"))).toBe(true);
    expect(page.layout.kind).toBe("GENERIC");
  });

  test("broken configuration JSON produces a parse warning", () => {
    const raw: RawPageResponse = { id: "x", name: "x", status: "DRAFT", configuration: "{not-json" };
    const page = parsePage(raw);
    expect(page.parseWarnings.some((w) => w.includes("JSON parse failed"))).toBe(true);
  });

  test("symbol configuration recognized as COMPONENT", () => {
    const inner = {
      __version: 5,
      inputs: ["a"],
      events: ["b"],
      helpText: {},
      layout: {
        id: "__node_id_root",
        name: "div",
        isSymbol: true,
        props: { layout: { type: "flex" } },
        children: [],
      },
      styles: "",
      variables: { generated: [], userDefined: [], derived: [] },
      httpRequests: { generated: [], userDefined: [] },
    };
    const raw: RawPageResponse = {
      id: "sym01",
      name: "my-symbol",
      status: "DRAFT",
      configuration: JSON.stringify(inner),
    };
    const page = parsePage(raw);
    expect(page.entityType).toBe("COMPONENT");
    expect(page.inputs).toEqual(["a"]);
    expect(page.events).toEqual(["b"]);
    expect(page.layout.kind).toBe("SYMBOL");
  });
});
