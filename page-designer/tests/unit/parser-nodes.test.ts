import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLayout, findNode, walkParsed } from "../../lib/parser/nodes";
import type { RawLayoutNode } from "../../lib/types/wire";

function fixture(name: string): RawLayoutNode {
  const body = readFileSync(join(__dirname, "fixtures", name), "utf8");
  return JSON.parse(body) as RawLayoutNode;
}

describe("parseLayout — node discriminators", () => {
  test("FORM_FIELD: well-formed node has field, no usesPropsInsteadOfField", () => {
    const { root } = parseLayout(fixture("node-form-field-valid.json"), []);
    expect(root.kind).toBe("FORM_FIELD");
    if (root.kind !== "FORM_FIELD") throw new Error("type narrowed");
    expect(root.usesPropsInsteadOfField).toBe(false);
    expect(root.fieldType).toBe("text");
    expect(root.valueBinding).toBe("userName");
    expect(root.validations.length).toBe(1);
    expect(root.raw).toBeDefined();
  });

  test("FORM_FIELD: bug-case (props instead of field) flags usesPropsInsteadOfField", () => {
    const { root } = parseLayout(fixture("node-form-field-props-bug.json"), []);
    expect(root.kind).toBe("FORM_FIELD");
    if (root.kind !== "FORM_FIELD") throw new Error("type narrowed");
    expect(root.usesPropsInsteadOfField).toBe(true);
    expect(root.field).toBeNull();
    // still captures type from props so the validator can still flag PHONE_FIELD_TYPE
    expect(root.fieldType).toBe("text");
  });

  test("DATA_TABLE: dynamic columns + matching variable with initialValue", () => {
    const { root } = parseLayout(
      fixture("node-data-table-dynamic-cols.json"),
      [
        {
          name: "dynColumns",
          type: "Any",
          initialValue: [], // non-empty array triggers hasInitialValueOnColumnsVar
          raw: null,
        },
      ],
    );
    expect(root.kind).toBe("DATA_TABLE");
    if (root.kind !== "DATA_TABLE") throw new Error("type narrowed");
    expect(root.hasDynamicColumns).toBe(true);
    expect(root.hasInitialValueOnColumnsVar).toBe(true);
    expect(root.rowDataBinding).toBe("tableData");
    expect(root.datasourceState).toBe("initial");
  });

  test("DATA_TABLE: hasInitialValueOnColumnsVar false when variable has no initialValue", () => {
    const { root } = parseLayout(
      fixture("node-data-table-dynamic-cols.json"),
      [{ name: "dynColumns", type: "Any", initialValue: null, raw: null }],
    );
    if (root.kind !== "DATA_TABLE") throw new Error("kind");
    expect(root.hasInitialValueOnColumnsVar).toBe(false);
  });

  test("BUTTON: dynamic className flagged", () => {
    const { root } = parseLayout(fixture("node-button-dynamic-classname.json"), []);
    expect(root.kind).toBe("BUTTON");
    if (root.kind !== "BUTTON") throw new Error("type narrowed");
    expect(root.hasDynamicClassName).toBe(true);
    expect(root.innerHTML).toBe("Submit");
  });

  test("SYMBOL: isSymbol wins over name-based discrimination; captures input bindings + events", () => {
    const { root } = parseLayout(fixture("node-symbol-ref.json"), []);
    expect(root.kind).toBe("SYMBOL");
    if (root.kind !== "SYMBOL") throw new Error("type narrowed");
    expect(root.symbolName).toBe("reply-mailbox-listing");
    expect(root.inputBindings).toEqual([
      { prop: "refreshList", binding: "{%triggerRefresh%}" },
    ]);
    expect(root.eventWires).toEqual(["selectedItem"]);
  });

  test("children-as-object: parser recovers but emits warning", () => {
    const { root, warnings } = parseLayout(fixture("node-children-object.json"), []);
    expect(root.children.length).toBe(2);
    expect(warnings.some((w) => w.includes("object-keyed children"))).toBe(true);
  });

  test("missing root layout returns synthetic empty node + warning", () => {
    const { root, warnings } = parseLayout(undefined, []);
    expect(root.kind).toBe("GENERIC");
    expect(root.nodeId).toBe("__missing_root");
    expect(warnings).toContain("missing layout root");
  });
});

describe("parseLayout — duplicate ids", () => {
  test("two children with same id → duplicateIds populated", () => {
    const raw: RawLayoutNode = {
      id: "__root",
      name: "div",
      props: { layout: { type: "flex" } },
      children: [
        { id: "__dup", name: "span" } as RawLayoutNode,
        { id: "__dup", name: "span" } as RawLayoutNode,
      ],
    };
    const { duplicateIds } = parseLayout(raw, []);
    expect(duplicateIds).toContain("__dup");
  });
});

describe("walkParsed / findNode", () => {
  test("walkParsed visits every node; findNode finds by id", () => {
    const raw: RawLayoutNode = {
      id: "__root",
      name: "div",
      props: { layout: { type: "flex" } },
      children: [
        {
          id: "__mid",
          name: "div",
          props: { layout: { type: "flex" } },
          children: [{ id: "__leaf", name: "button", props: { innerHTML: "ok" } }],
        } as RawLayoutNode,
      ],
    };
    const { root } = parseLayout(raw, []);
    const ids: string[] = [];
    walkParsed(root, (n) => ids.push(n.nodeId));
    expect(ids).toEqual(["__root", "__mid", "__leaf"]);

    const leaf = findNode(root, "__leaf");
    expect(leaf?.kind).toBe("BUTTON");
  });
});
