// Stage 7 (7.8): pd-review §3a–3d + figma-to-pd lint rules. Every rule has a
// positive and a negative case; UNUSED_VARIABLE false positives found on real
// pages have regression tests; every emitted code is catalogued and listed in
// help.txt; validate --recursive checks page ↔ symbol interfaces.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { parsePage } from "../../lib/parser/index";
import { ESCALATE_WHEN_INTRODUCED, validateEdit, validateHydrated } from "../../lib/validator/index";
import { PD_RULES } from "../../lib/validator/catalogue";
import { cssSelectors } from "../../lib/validator/rules/lint";
import { symbolInterfaceIssues, validateRecursive } from "../../lib/validator/recursive";
import type { RawPageResponse } from "../../lib/types/wire";
import { jsonFixtures } from "@belzabar/core/testing";

const REAL = `${import.meta.dir}/../fixtures/real`;
const realFiles = readdirSync(REAL).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
const loadReal = (id: string) => jsonFixtures(REAL, ".json")<RawPageResponse>(id);

function wrap(inner: unknown, over: Partial<RawPageResponse> = {}): RawPageResponse {
  return { id: "t1", name: "t", status: "DRAFT", relativeRoute: "t", configuration: JSON.stringify(inner), ...over };
}
const comp = (inner: unknown, name = "sym") => wrap(inner, { id: `id-${name}`, name, relativeRoute: undefined, isComponent: true });

function pageInner(extra: Record<string, unknown> = {}, children: unknown[] = []) {
  return {
    __version: 5,
    layout: { id: "__root", name: "div", props: {}, children, unSelectable: true },
    styles: "",
    variables: { generated: [], userDefined: [] as unknown[] },
    httpRequests: { generated: [], userDefined: [] as unknown[] },
    ...extra,
  };
}
const vars = (...userDefined: unknown[]) => ({ variables: { generated: [], userDefined } });
const http = (...userDefined: unknown[]) => ({ httpRequests: { generated: [], userDefined } });
const call = (over: { label?: string; callId?: string; url?: string; method?: string; trigger?: string[]; error?: unknown[]; isAuthorized?: boolean } = {}) => ({
  meta: { serviceCall: { label: over.label ?? "Get things", callId: over.callId ?? "sc-1", serviceId: 1, inputState: [] } },
  handler: { error: over.error ?? [["{%err%}", "get('$error')"]], success: [["{%out%}", "get('$bodyJson')"]] },
  request: { url: over.url ?? "/rest/api/automation/chain/execute/abc", method: over.method ?? "POST", isAuthorized: over.isAuthorized ?? true, body: "{}" },
  trigger: over.trigger ?? ["this.go"],
  triggerFilter: "pipe(constant(true))",
});
const baseVars = [{ name: "go", type: "Boolean" }, { name: "out", type: "Any" }, { name: "err", type: "Any" }];
const issuesOf = (raw: RawPageResponse) => validateHydrated(parsePage(raw));
const codes = (raw: RawPageResponse, code: string) => issuesOf(raw).filter((i) => i.code === code);
/** A page that exercises the variables so only the rule under test fires. */
const withUse = (children: unknown[] = []) => [{ id: "use", name: "div", props: { innerHTML: "{%go%}{%out%}{%err%}" } }, ...children];

describe("pd-review §3a structural", () => {
  test("MISSING_NODE_ID: a node without id (not the root of a style-only symbol)", () => {
    expect(codes(wrap(pageInner({}, [{ name: "span", _elementId: "e1" }])), "MISSING_NODE_ID")).toHaveLength(1);
    expect(codes(wrap(pageInner({}, [{ id: "a", name: "span" }])), "MISSING_NODE_ID")).toHaveLength(0);
  });

  test("style-only symbol ({isSymbol:true} layout, found live) is neither malformed nor id-less", () => {
    const raw = comp({ ...pageInner(), layout: { isSymbol: true }, styles: ".latest-version .x{}" });
    const issues = issuesOf(raw);
    expect(issues.map((i) => i.code)).not.toContain("ROOT_LAYOUT_MALFORMED");
    expect(issues.map((i) => i.code)).not.toContain("MISSING_NODE_ID");
    // but a component whose layout is a bare {children:[…]} wrapper still is (figma L1)
    const wrapper = comp({ ...pageInner(), layout: { children: [{ id: "s", name: "span" }] } });
    expect(issuesOf(wrapper).filter((i) => i.code === "ROOT_LAYOUT_MALFORMED" && i.severity === "error").length).toBeGreaterThan(0);
  });

  test("ORPHAN_HTTP_TRIGGER: trigger variable not defined (onInit left to MISSING_ONINIT_VAR)", () => {
    const bad = wrap(pageInner({ ...vars(...baseVars), ...http(call({ trigger: ["this.nope"] })) }, withUse()));
    expect(codes(bad, "ORPHAN_HTTP_TRIGGER")).toMatchObject([{ path: "sc-1" }]);
    const good = wrap(pageInner({ ...vars(...baseVars), ...http(call({ trigger: ["this.go", "this.onInit"] })) }, withUse()));
    expect(codes(good, "ORPHAN_HTTP_TRIGGER")).toHaveLength(0);
  });

  test("ORPHAN_EVENT_TARGET: handler writes this.x with x undefined", () => {
    const ev = (target: string) => [{ id: "b", name: "button", events: { click: [[target, "(function(d){return 1})"]] } }];
    expect(codes(wrap(pageInner(vars(...baseVars), withUse(ev("this.missing")))), "ORPHAN_EVENT_TARGET")).toHaveLength(1);
    expect(codes(wrap(pageInner(vars(...baseVars), withUse(ev("this.go")))), "ORPHAN_EVENT_TARGET")).toHaveLength(0);
    expect(codes(wrap(pageInner(vars(...baseVars), withUse(ev("pageContext.x")))), "ORPHAN_EVENT_TARGET")).toHaveLength(0);
  });

  test("UNUSED_HTTP_REQUEST: a call with no trigger", () => {
    expect(codes(wrap(pageInner({ ...vars(...baseVars), ...http(call({ trigger: [] })) }, withUse())), "UNUSED_HTTP_REQUEST")).toHaveLength(1);
    expect(codes(wrap(pageInner({ ...vars(...baseVars), ...http(call()) }, withUse())), "UNUSED_HTTP_REQUEST")).toHaveLength(0);
  });

  test("V1 / HTTP_NOT_ARRAY: keyed buckets are errors; arrays are fine", () => {
    const bad = wrap({ ...pageInner(), variables: { generated: [], userDefined: { a: {} } }, httpRequests: { generated: [], userDefined: { getX: {} } } });
    const found = issuesOf(bad).filter((i) => i.severity === "error").map((i) => i.code);
    expect(found).toContain("V1");
    expect(found).toContain("HTTP_NOT_ARRAY");
    expect(issuesOf(wrap(pageInner())).map((i) => i.code)).not.toContain("V1");
    expect(issuesOf(wrap(pageInner())).map((i) => i.code)).not.toContain("HTTP_NOT_ARRAY");
  });
});

describe("pd-review §3c/§3d HTTP + accessibility", () => {
  const page = (c: ReturnType<typeof call>) => wrap(pageInner({ ...vars(...baseVars), ...http(c) }, withUse()));

  test("HTTP_NO_ERROR_HANDLER", () => {
    expect(codes(page(call({ error: [] })), "HTTP_NO_ERROR_HANDLER")).toMatchObject([{ path: "sc-1" }]);
    expect(codes(page(call()), "HTTP_NO_ERROR_HANDLER")).toHaveLength(0);
  });

  test("HTTP_MUTATION_ON_LOAD: write label or PUT/DELETE on onInit; 'Get …' on onInit and writes on a button trigger are fine", () => {
    expect(codes(page(call({ label: "Save Application", trigger: ["this.onInit"] })), "HTTP_MUTATION_ON_LOAD")).toHaveLength(1);
    expect(codes(page(call({ label: "studentUpdateRecord", trigger: ["this.onInit"] })), "HTTP_MUTATION_ON_LOAD")).toHaveLength(1);
    expect(codes(page(call({ label: "x", method: "DELETE", trigger: ["this.onInit"] })), "HTTP_MUTATION_ON_LOAD")).toHaveLength(1);
    expect(codes(page(call({ label: "Get Valid Enrollment Processes", trigger: ["this.onInit"] })), "HTTP_MUTATION_ON_LOAD")).toHaveLength(0);
    expect(codes(page(call({ label: "Save Application", trigger: ["this.go"] })), "HTTP_MUTATION_ON_LOAD")).toHaveLength(0);
  });

  test("HTTP_HARDCODED_URL", () => {
    expect(codes(page(call({ url: "https://acme.example.com/rest/api/x" })), "HTTP_HARDCODED_URL")).toHaveLength(1);
    expect(codes(page(call()), "HTTP_HARDCODED_URL")).toHaveLength(0);
  });

  test("HTTP_NOT_AUTHORIZED", () => {
    expect(codes(page(call({ isAuthorized: false })), "HTTP_NOT_AUTHORIZED")).toHaveLength(1);
    expect(codes(page(call()), "HTTP_NOT_AUTHORIZED")).toHaveLength(0);
  });

  test("IMG_NO_ALT (props or attrs alt count)", () => {
    expect(codes(wrap(pageInner({}, [{ id: "i", name: "img", props: { src: "a.png" } }])), "IMG_NO_ALT")).toHaveLength(1);
    expect(codes(wrap(pageInner({}, [{ id: "i", name: "img", props: { src: "a.png", alt: "Logo" } }])), "IMG_NO_ALT")).toHaveLength(0);
    expect(codes(wrap(pageInner({}, [{ id: "i", name: "img", attrs: { alt: "Logo" } }])), "IMG_NO_ALT")).toHaveLength(0);
  });
});

describe("figma-to-pd rules (codes kept)", () => {
  const table = (props: Record<string, unknown>) => [{ id: "tbl", name: "exp-data-table", props: { datasourceState: "initial", ...props } }];

  test("V4: types outside the enum; the acme-dev editor's String/Boolean/Number are valid", () => {
    expect(codes(wrap(pageInner(vars({ name: "a", type: "List" }), [{ id: "x", name: "div", props: { innerHTML: "{%a%}" } }])), "V4")).toHaveLength(1);
    for (const t of ["String", "Boolean", "Number", "Any", "KeyValue", "PAGINATION_STORE", "boolean"]) {
      expect(codes(wrap(pageInner(vars({ name: "a", type: t }))), "V4")).toHaveLength(0);
    }
  });

  test("T1: static datasourceState must be 'initial'", () => {
    expect(codes(wrap(pageInner({}, table({ datasourceState: "loaded" }))), "T1")).toHaveLength(1);
    expect(codes(wrap(pageInner({}, table({}))), "T1")).toHaveLength(0);
  });

  test("T2: {%v.rows%} needs {rows:[…]}; a raw array bound directly is flagged; HTTP-filled (null) is fine", () => {
    expect(codes(wrap(pageInner(vars({ name: "t", type: "Any", initialValue: { list: [] } }), table({ "[rowData]": "{%t.rows%}" }))), "T2")).toHaveLength(1);
    expect(codes(wrap(pageInner(vars({ name: "t", type: "Any", initialValue: [{ a: 1 }] }), table({ "[rowData]": "{%t%}" }))), "T2")).toHaveLength(1);
    expect(codes(wrap(pageInner(vars({ name: "t", type: "Any", initialValue: { rows: [] } }), table({ "[rowData]": "{%t.rows%}" }))), "T2")).toHaveLength(0);
    expect(codes(wrap(pageInner(vars({ name: "t", type: "Any", initialValue: null }), table({ "[rowData]": "{%t%}" }))), "T2")).toHaveLength(0);
  });

  test("T3 / T6 / C5 / T4 on static rows", () => {
    const rowsVar = (rows: unknown[], type = "Any") => vars({ name: "t", type, initialValue: { rows } });
    const cols = { columns: [{ key: "a" }, { key: "b" }], "[rowData]": "{%t.rows%}" };
    expect(codes(wrap(pageInner(rowsVar([{ a: "x".repeat(401), b: 1 }]), table(cols))), "T3")).toHaveLength(1);
    expect(codes(wrap(pageInner(rowsVar([{ a: "<span>on</span>", b: 1 }]), table(cols))), "T6")).toHaveLength(1);
    expect(codes(wrap(pageInner(rowsVar([{ a: "x" }]), table(cols))), "C5")).toMatchObject([{ message: expect.stringContaining("b") }]);
    expect(codes(wrap(pageInner(rowsVar([{ a: "x", b: 1 }], "Object"), table(cols))), "T4")).toHaveLength(1);
    const clean = wrap(pageInner(rowsVar([{ a: "x", b: 1 }]), table(cols)));
    for (const c of ["T3", "T4", "T6", "C5"]) expect(codes(clean, c)).toHaveLength(0);
  });

  test("T5: $src.$row interpolation in plain HTML of a dict cellLayout", () => {
    const cl = (props: Record<string, unknown>, name = "div") => table({ columns: [{ key: "a", cellLayout: { name: "div", children: [{ name, props }] } }] });
    expect(codes(wrap(pageInner({}, cl({ "[innerHTML]": "{%$src.$row.name%}" }))), "T5")).toHaveLength(1);
    expect(codes(wrap(pageInner({}, cl({ "[checkboxText]": "{%$src.$row.name%}" }, "exp-form-field"))), "T5")).toHaveLength(0);
  });

  test("R1: static isVisible next to [isVisible]", () => {
    expect(codes(wrap(pageInner(vars({ name: "v", type: "Boolean" }), [{ id: "a", name: "div", props: { isVisible: true, "[isVisible]": "{%v%}" } }])), "R1")).toHaveLength(1);
    expect(codes(wrap(pageInner(vars({ name: "v", type: "Boolean" }), [{ id: "a", name: "div", props: { "[isVisible]": "{%v%}" } }])), "R1")).toHaveLength(0);
  });

  test("DIALOG_VISIBILITY: [visible]/[isVisible] without [show]", () => {
    const d = (props: Record<string, unknown>) => wrap(pageInner(vars({ name: "open", type: "Boolean" }), [{ id: "d", name: "exp-layout-dialog", props }]));
    expect(codes(d({ "[visible]": "{%open%}" }), "DIALOG_VISIBILITY")).toHaveLength(1);
    expect(codes(d({ "[show]": "{%open%}" }), "DIALOG_VISIBILITY")).toHaveLength(0);
  });

  test("ITEM_DIRECT_ACCESS: {%$item.x%} vs {%$item.value%}?.x", () => {
    expect(codes(wrap(pageInner({}, [{ id: "a", name: "div", props: { innerHTML: "{%$item.status%}" } }])), "ITEM_DIRECT_ACCESS")).toMatchObject([{ path: "$item.status" }]);
    expect(codes(wrap(pageInner({}, [{ id: "a", name: "div", props: { innerHTML: "{%$item.value%}?.status {%$item.index%}" } }])), "ITEM_DIRECT_ACCESS")).toHaveLength(0);
  });

  test("H1 / F1: long html templates and raw inputs in templates", () => {
    expect(codes(wrap(pageInner({}, [{ id: "h", name: "exp-html-template", props: { template: `<div>${"x".repeat(420)}</div>` } }])), "H1")).toHaveLength(1);
    expect(codes(wrap(pageInner({}, [{ id: "h", name: "exp-html-template", props: { template: `<svg>${"x".repeat(420)}</svg>` } }])), "H1")).toHaveLength(0);
    expect(codes(wrap(pageInner({}, [{ id: "h", name: "div", props: { innerHTML: "<input type=text>" } }])), "F1")).toHaveLength(1);
    expect(codes(wrap(pageInner({}, [{ id: "h", name: "div", props: { innerHTML: "<b>hi</b>" } }])), "F1")).toHaveLength(0);
  });

  test("CSS_NOT_SCOPED (one per page) and U1", () => {
    expect(codes(wrap(pageInner({ styles: ".a{color:red}\n.b{x:1}" })), "CSS_NOT_SCOPED")).toMatchObject([{ message: expect.stringContaining("2 style rule") }]);
    expect(codes(wrap(pageInner({ styles: ".latest-version .a{color:red} @media (max-width:1px){.latest-version .b{x:1}} /* .c{} */" })), "CSS_NOT_SCOPED")).toHaveLength(0);
    expect(cssSelectors("@keyframes k{from{a:1}to{a:2}} .latest-version .x{}")).toEqual([".latest-version .x"]);
    expect(codes(wrap(pageInner({ styles: ".latest-version .a{background:url(data:image/svg+xml;utf8,<svg\n/>)}" })), "U1")).toHaveLength(1);
    expect(codes(wrap(pageInner({ styles: ".latest-version .a{background:url(x.png)}" })), "U1")).toHaveLength(0);
  });
});

describe("UNUSED_VARIABLE false positives (Stage 6 reported 126 on Student Application)", () => {
  const unused = (raw: RawPageResponse) => codes(raw, "UNUSED_VARIABLE").map((i) => i.path);

  test("names reached from custom code by string or via the scope object are used", () => {
    const code = "(function(data){ const $api = data.$api; $api.setVariableValue('a', 1); const x = $api.getVariableValue(\"b\"); return get('c') + data.d + params['e']; })";
    const raw = wrap(pageInner(vars(...["a", "b", "c", "d", "e", "dead"].map((name) => ({ name, type: "Any" }))), [
      { id: "btn", name: "button", events: { click: [["this.a", code]] } },
    ]));
    expect(unused(raw)).toEqual(["dead"]);
  });

  test("side-effect derived vars, onInit/routeParams and a component's declared events are not reported", () => {
    const raw = comp({
      ...pageInner(vars(
        { name: "onInit", type: "Boolean" },
        { name: "routeParams", type: "KeyValue" },
        { name: "emitted", type: "Any" },
        { name: "watcher", type: "Any", from: ["emitted"], spec: "(function(p){})", sideEffect: true, compileType: "DERIVED" },
        { name: "pureDead", type: "Any", from: ["emitted"], spec: "(function(p){})", sideEffect: false, compileType: "DERIVED" },
      )),
      layout: { id: "r", name: "div", isSymbol: true, unSelectable: true, children: [] },
      events: ["emitted"],
      inputs: [],
    });
    expect(unused(raw)).toEqual(["pureDead"]);
  });

  test("Student Application: 126 → 50, and every remaining name occurs only in its own definition", () => {
    const raw = loadReal("4cba8f39eb92d136694dadc4e7f2a811");
    const names = unused(raw);
    expect(names).toHaveLength(50);
    const text = raw.configuration as string;
    for (const n of names) {
      const esc = n!.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const uses = [...text.matchAll(new RegExp(`\\{%\\s*${esc}\\b|this\\.${esc}\\b|['"]${esc}['"]\\s*\\)`, "g"))];
      expect(uses).toHaveLength(0);
    }
  });
});

describe("calibration + catalogue", () => {
  test("every code emitted on the real fixtures is catalogued and documented in help.txt", () => {
    const help = readFileSync(`${import.meta.dir}/../../commands/validate/help.txt`, "utf8");
    for (const code of Object.keys(PD_RULES)) expect(help).toContain(code);
    for (const f of realFiles) {
      const raw = JSON.parse(readFileSync(`${REAL}/${f}`, "utf8")) as RawPageResponse;
      for (const i of issuesOf(raw)) expect(PD_RULES[i.code], i.code).toBeDefined();
    }
  });

  test("escalated codes are warn by default and block only when an edit introduces them", () => {
    // ORPHAN_BINDING is already an error in author config; it is escalated from its generated-config warn.
    for (const code of ESCALATE_WHEN_INTRODUCED) if (code !== "ORPHAN_BINDING") expect(PD_RULES[code]?.severity).toBe("warn");
    const before = parsePage(wrap(pageInner(vars(...baseVars), withUse())));
    const after = parsePage(wrap(pageInner(vars(...baseVars), withUse([{ id: "d", name: "exp-layout-dialog", props: { "[visible]": "{%go%}" } }]))));
    const issue = validateEdit(before, after).find((i) => i.code === "DIALOG_VISIBILITY");
    expect(issue).toMatchObject({ severity: "error", introduced: true });
    expect(validateEdit(after, after).find((i) => i.code === "DIALOG_VISIBILITY")).toMatchObject({ severity: "warn", preExisting: true });
  });
});

describe("validate --recursive (page ↔ symbols)", () => {
  const symbol = (name: string, inputs: string[], events: string[], children: unknown[] = []) =>
    comp({ ...pageInner(), layout: { id: `r-${name}`, name: "div", isSymbol: true, unSelectable: true, children }, inputs, events }, name);
  let seq = 0;
  const inst = (name: string, props: Record<string, unknown> = {}, events: Record<string, unknown> = {}) => ({ id: `i-${name}-${seq++}`, name, isSymbol: true, props, events });

  test("SYMBOL_UNKNOWN_INPUT / _EVENT against the symbol's declared interface", () => {
    const page = parsePage(wrap(pageInner(vars(...baseVars), withUse([inst("child", { "[a]": "{%go%}", "[zz]": "{%go%}" }, { done: [], bogus: [] })]))));
    const child = parsePage(symbol("child", ["a"], ["done"]));
    const issues = symbolInterfaceIssues(page, new Map([["child", child]]));
    expect(issues.map((i) => [i.code, i.message.includes("zz") || i.message.includes("bogus")])).toEqual([
      ["SYMBOL_UNKNOWN_INPUT", true],
      ["SYMBOL_UNKNOWN_EVENT", true],
    ]);
    const okPage = parsePage(wrap(pageInner(vars(...baseVars), withUse([inst("child", { "[a]": "{%go%}" }, { done: [] })]))));
    expect(symbolInterfaceIssues(okPage, new Map([["child", child]]))).toEqual([]);
  });

  test("walks symbols transitively once each, reports missing symbols and chains deeper than 3", async () => {
    const lib: Record<string, RawPageResponse> = {
      s1: symbol("s1", [], [], [inst("s2"), inst("ghost")]),
      s2: symbol("s2", [], [], [inst("s3")]),
      s3: symbol("s3", [], [], [inst("s4")]),
      s4: symbol("s4", [], []),
    };
    const fetched: string[] = [];
    const root = wrap(pageInner({}, [inst("s1"), inst("s1")]), { name: "Root" });
    const rep = await validateRecursive(root, { byName: async (n) => (fetched.push(n), lib[n] ?? null) });
    expect(fetched.sort()).toEqual(["ghost", "s1", "s2", "s3", "s4"]);
    expect(rep.entries.map((e) => [e.name, e.depth])).toEqual([["Root", 0], ["s1", 1], ["s2", 2], ["s3", 3], ["s4", 4]]);
    expect(rep.longestChain).toEqual(["Root", "s1", "s2", "s3", "s4"]);
    expect(rep.entries[0]!.issues.find((i) => i.code === "SYMBOL_NESTING_DEPTH")?.message).toContain("4 levels");
    expect(rep.entries[1]!.issues.find((i) => i.code === "SYMBOL_NOT_FOUND")?.message).toContain("ghost");
    expect(rep.errorCount).toBe(0);
  });

  test("real fixtures: Add Student (45f7…) → student-add-component / check_permission / admin_portal_footer", async () => {
    const byName: Record<string, string> = {
      "student-add-component": "436e2f3848865e1f11cdbe393b1f6545",
      check_permission: "438fe77cffb8f165a3df9eb2a74cab05",
      admin_portal_footer: "4f4f9ce1b7affcccee14aa9b5b006427",
    };
    const rep = await validateRecursive(loadReal("45f7671e3c51c7247e12a640e3fb6d85"), {
      byName: async (n) => (byName[n] ? loadReal(byName[n]!) : null),
    });
    expect(rep.errorCount).toBe(0);
    const names = rep.entries.map((e) => e.name);
    expect(names).toContain("student-add-component");
    expect(names).toContain("check_permission");
    // the symbols this env has no fixture for are reported, not fatal
    expect(rep.entries[0]!.issues.some((i) => i.code === "SYMBOL_NOT_FOUND")).toBe(true);
  });
});
