// PD-5: validator calibration against the 15 real sems-dev pages/components.
// Real editor output must produce 0 errors; the demoted rules still catch
// their true positives, and validateEdit escalates them when an edit
// introduces one. PD-26: duplicate ids reported once; INVALID_JSON exists.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { parsePage } from "../../lib/parser/index";
import { applyOverlay } from "../../lib/serialize/index";
import { partitionBySeverity, validateEdit, validateHydrated } from "../../lib/validator/index";
import type { RawPageResponse } from "../../lib/types/wire";

const DIR = `${import.meta.dir}/../fixtures/real`;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
const load = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as RawPageResponse;

function wrap(inner: unknown, over: Partial<RawPageResponse> = {}): RawPageResponse {
  return { id: "t1", name: "t", status: "DRAFT", relativeRoute: "t", configuration: JSON.stringify(inner), ...over };
}

function pageInner(extra: Record<string, unknown> = {}, children: unknown[] = []) {
  return {
    __version: 5,
    layout: { id: "__root", name: "div", props: {}, children, unSelectable: true },
    styles: "",
    variables: { generated: [], userDefined: [], derived: [] },
    httpRequests: { generated: [], userDefined: [] },
    ...extra,
  };
}

const codesOf = (issues: Array<{ code: string; severity: string }>, severity?: string) =>
  issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

describe("calibration: real editor output has 0 validator errors", () => {
  expect(files.length).toBe(15);
  for (const f of files) {
    const raw = load(f);
    test(`${raw.id.slice(0, 10)} ${raw.name}`, () => {
      const { errors } = partitionBySeverity(validateHydrated(parsePage(raw)));
      expect(errors).toEqual([]);
    });
  }

  test("an unedited real page passes the edit gate too", () => {
    for (const f of files) {
      const page = parsePage(load(f));
      expect(partitionBySeverity(validateEdit(page, page)).errors).toEqual([]);
    }
  });
});

describe("ORPHAN_BINDING (calibrated)", () => {
  const vars = (userDefined: unknown[], generated: unknown[] = []) => ({ generated, userDefined, derived: [] });

  test("dotted / indexed paths resolve by their root variable", () => {
    const p = parsePage(wrap(pageInner({ variables: vars([{ name: "form", initialValue: null }]) }, [
      { id: "a", name: "div", props: { "[innerHTML]": "{%form.a.b%}", x: "{%form[0].c%}" } },
    ])));
    expect(codesOf(validateHydrated(p))).not.toContain("ORPHAN_BINDING");
  });

  test("runtime scope ($item, $$nav…, pageContext) and component inputs are defined", () => {
    const p = parsePage(wrap({
      ...pageInner({ inputs: ["studentId"] }, [
        { id: "a", name: "div", props: { a: "{%$item.value%}", b: "{%$$navigationUrl1%}", c: "{%pageContext.x%}", d: "{%studentId%}" } },
      ]),
    }, { relativeRoute: undefined, isComponent: true }));
    expect(codesOf(validateHydrated(p))).not.toContain("ORPHAN_BINDING");
  });

  test("names are matched trimmed (a real derived var is named ' loaderTextNull')", () => {
    const p = parsePage(wrap(pageInner({ variables: vars([{ name: " loaderTextNull", from: [], spec: "" }]) }, [
      { id: "a", name: "exp-loader", props: { "[note]": "{% loaderTextNull%}" } },
    ])));
    expect(codesOf(validateHydrated(p))).not.toContain("ORPHAN_BINDING");
  });

  test("true positive: an undefined variable in the layout is an error, reported once per root", () => {
    const p = parsePage(wrap(pageInner({}, [
      { id: "a", name: "div", props: { a: "{%missing.x%}", b: "{%missing.y%}" } },
    ])));
    const orphans = validateHydrated(p).filter((i) => i.code === "ORPHAN_BINDING");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ severity: "error", path: "missing" });
  });

  test("inside variables.generated (editor-owned form config) it is only a warning", () => {
    const p = parsePage(wrap(pageInner({
      variables: vars([], [{ name: "__form_config_var1", type: "KeyValue", initialValue: { form: { fields: [{ "[(value)]": "{%gone%}" }] } } }]),
    })));
    const orphans = validateHydrated(p).filter((i) => i.code === "ORPHAN_BINDING");
    expect(orphans.map((o) => o.severity)).toEqual(["warn"]);
  });
});

describe("ROOT_LAYOUT_MALFORMED (calibrated)", () => {
  test("page root without _elementId, component root with unSelectable: no issue (real shapes)", () => {
    expect(codesOf(validateHydrated(parsePage(wrap(pageInner()))))).not.toContain("ROOT_LAYOUT_MALFORMED");
    const comp = { ...pageInner(), layout: { id: "r", name: "div", isSymbol: true, unSelectable: true, children: [] } };
    expect(codesOf(validateHydrated(parsePage(wrap(comp, { relativeRoute: undefined, isComponent: true }))))).not.toContain(
      "ROOT_LAYOUT_MALFORMED",
    );
  });

  test("true positives: page root without unSelectable, component root without isSymbol, non-div root", () => {
    const noUnsel = { ...pageInner(), layout: { id: "r", name: "div", children: [] } };
    expect(codesOf(validateHydrated(parsePage(wrap(noUnsel))), "error")).toContain("ROOT_LAYOUT_MALFORMED");
    const compNoSym = { ...pageInner(), layout: { id: "r", name: "div", unSelectable: true, children: [] } };
    expect(codesOf(validateHydrated(parsePage(wrap(compNoSym, { relativeRoute: undefined, isComponent: true }))), "error")).toContain(
      "ROOT_LAYOUT_MALFORMED",
    );
    const span = { ...pageInner(), layout: { id: "r", name: "span", unSelectable: true, children: [] } };
    expect(codesOf(validateHydrated(parsePage(wrap(span))), "error")).toContain("ROOT_LAYOUT_MALFORMED");
  });
});

describe("validateEdit: diff-aware gate", () => {
  const base = pageInner(
    { variables: { generated: [], userDefined: [{ name: "items", type: "Any", initialValue: [1] }], derived: [] } },
    [{ id: "keep", name: "div", props: { innerHTML: "{%items%}" } }],
  );

  test("warn-level rules already on the page stay warnings (pre-existing)", () => {
    const before = parsePage(wrap(base));
    const issues = validateEdit(before, before);
    const arr = issues.find((i) => i.code === "ARRAY_INITIAL_VALUE");
    expect(arr).toMatchObject({ severity: "warn", preExisting: true });
  });

  test("an edit that INTRODUCES an orphan binding / array initialValue / derived-in-innerHTML is blocked", () => {
    const before = parsePage(wrap(base));
    const after = applyOverlay(before, {
      variables: { add: [{ name: "list2", type: "Any", initialValue: [2] }] },
      derived: { add: [{ name: "dv", from: ["items"], spec: "x" }] },
      elements: {
        operations: [
          { key: "layout.children[0].props.innerHTML", value: "{%typo%}", operation: "UPDATE", dataType: "STRING" },
          { key: "layout.children[0].props.[textContent]", value: "{%dv%}", operation: "CREATE", dataType: "STRING" },
        ],
      },
    });
    const errors = partitionBySeverity(validateEdit(before, after)).errors;
    expect(errors.map((e) => e.code).sort()).toEqual(["ARRAY_INITIAL_VALUE", "DERIVED_IN_INNERHTML", "ORPHAN_BINDING"]);
    expect(errors.every((e) => e.introduced)).toBe(true);
  });

  test("a pre-existing ERROR never blocks an unrelated edit", () => {
    const broken = pageInner({}, [{ id: "ff", name: "exp-form-field", props: { type: "text" } }]);
    const before = parsePage(wrap(broken));
    expect(codesOf(validateHydrated(before), "error")).toContain("FORM_FIELD_PROPS");
    const after = applyOverlay(before, { styles: { replace: ".x{}" } });
    const issues = validateEdit(before, after);
    expect(partitionBySeverity(issues).errors).toEqual([]);
    expect(issues.find((i) => i.code === "FORM_FIELD_PROPS")).toMatchObject({ severity: "warn", preExisting: true });
  });
});

describe("PD-26", () => {
  test("a duplicate _elementId used as the node id is reported once", () => {
    const p = parsePage(wrap(pageInner({}, [
      { name: "span", _elementId: "e1" },
      { name: "span", _elementId: "e1" },
    ])));
    expect(validateHydrated(p).filter((i) => i.code === "DUPLICATE_ELEMENT_IDS")).toHaveLength(1);
  });

  test("INVALID_JSON is a real rule", () => {
    const p = parsePage({ id: "x", name: "x", status: "DRAFT", configuration: "{not json" });
    expect(codesOf(validateHydrated(p), "error")).toContain("INVALID_JSON");
  });
});
