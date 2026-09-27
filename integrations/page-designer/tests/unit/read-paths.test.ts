// Read-side fixes: input resolution (PD-10, PD-17, PD-18, PD-28), recursive
// analysis without components.json (PD-13 / F21, PD-19, PD-25),
// find-ad-methods by name (PD-14 / F20), finder dedupe + limit (F19 / PD-27),
// diff engine coverage (PD-11).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { runCommand } from "@belzabar/core/testing";
import findAdMethods from "../../commands/find-ad-methods/index";
import analyze from "../../commands/analyze/index";
import show from "../../commands/show/index";
import { analyzeItem } from "../../lib/analyzer";
import { childComponentNames } from "../../lib/extract";
import { diffPages, isIdentical } from "../../lib/page-diff";
import { collapsePairs, searchPageIndex, type PageFinderIndex } from "../../lib/page-finder";
import { parsePage } from "../../lib/parser/index";
import { applyOverlay } from "../../lib/serialize/index";
import { detectInputKind, resolveInput } from "../../lib/resolver";
import { cleanInner, ENV, page, startFakePd, type FakePd } from "./helpers/fake-pd";

const PAGE = "a0000000000000000000000000000001";
const COMP = "c0000000000000000000000000000001";
const COMP2 = "c0000000000000000000000000000002";
const exec = (adId: string, callId: string) => ({
  meta: { serviceCall: { callId, label: callId } },
  request: { url: `/rest/api/automation/chain/execute/${adId}`, method: "POST" },
  handler: { success: [], error: [] },
  trigger: [],
});

let pd: FakePd;
beforeEach(() => {
  rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
  const pageInner = cleanInner({ httpRequests: { generated: [], userDefined: [exec("ad1", "h1")] } });
  pageInner.layout.children.push({ id: "s1", name: "widget", isSymbol: true, props: {} } as any, { id: "s2", name: "ghost", isSymbol: true, props: {} } as any);
  const compInner = {
    ...cleanInner({ httpRequests: { generated: [], userDefined: [exec("ad2", "h2")] } }),
    layout: { id: "cr", name: "div", isSymbol: true, unSelectable: true, props: {}, children: [{ id: "x", name: "widget", isSymbol: true, props: {} }] },
  };
  pd = startFakePd([
    page(PAGE, pageInner, { name: "Add Student" }),
    page(COMP, compInner, { name: "widget", isComponent: true, relativeRoute: undefined }),
    page(COMP2, compInner, { name: "Add Student", isComponent: true, relativeRoute: undefined }),
  ]);
  pd.searchRows = [
    { id: PAGE, name: "Add Student", status: "DRAFT" },
    { id: COMP, name: "widget", status: "DRAFT", isComponent: true },
  ];
});
afterEach(() => pd.restore());
const run = (cmd: Parameters<typeof runCommand>[0], argv: string[]) => runCommand(cmd, argv, { env: ENV });

describe("resolveInput", () => {
  test("PD-10: entity type is the server's, whatever the input kind", async () => {
    expect((await resolveInput(COMP)).entityType).toBe("COMPONENT"); // a bare id used to be PAGE
    expect((await resolveInput(PAGE)).entityType).toBe("PAGE");
    expect((await resolveInput("widget")).entityType).toBe("COMPONENT");
  });

  test("PD-28: a page NAME resolves (only component names used to)", async () => {
    const r = await resolveInput("Add Student");
    expect(r).toMatchObject({ resolvedId: PAGE, entityType: "PAGE", inputKind: "name" });
  });

  test("names are exact and never guessed: several matches → PD_NAME_AMBIGUOUS", async () => {
    pd.searchRows.push({ id: "a0000000000000000000000000000002", name: "Add Student", status: "DRAFT" });
    await expect(resolveInput("Add Student")).rejects.toMatchObject({ code: "PD_NAME_AMBIGUOUS" });
    await expect(resolveInput("nobody")).rejects.toMatchObject({ code: "COMPONENT_NOT_FOUND" });
  });

  test("PD-18: a 5xx on the name search is an API error, not 'not found'", async () => {
    pd.searchStatus = 500;
    await expect(resolveInput("widget")).rejects.toMatchObject({ code: "PD_API_ERROR", details: { status: 500 } });
  });

  test("PD-17: malformed URLs are INVALID_URL CliErrors", () => {
    expect(() => detectInputKind("https://")).toThrow(expect.objectContaining({ code: "INVALID_URL" }));
    expect(() => detectInputKind("https://h.test/ui-designer/symbol/%E0%A4%A")).toThrow(expect.objectContaining({ code: "INVALID_URL" }));
    expect(detectInputKind("https://h.test/ui-designer/symbol/my%20comp")).toMatchObject({ kind: "pd-url", urlType: "COMPONENT", pdToken: "my comp" });
  });
});

describe("recursive analysis (PD-13 / F21, PD-19, PD-25)", () => {
  test("childComponentNames skips the root (a component root is isSymbol) and de-dupes", () => {
    const comp = parsePage(pd.pages.get(COMP)!);
    expect(comp.layout.kind).toBe("SYMBOL");
    expect(childComponentNames(comp)).toEqual(["widget"]);
  });

  test("follows every symbol without components.json; failures are collected, not swallowed", async () => {
    const errors: Array<{ name: string }> = [];
    const tree = await analyzeItem(PAGE, "root", new Set(), errors as any);
    expect(tree).toMatchObject({ type: "PAGE", adIds: ["ad1"], children: [{ id: COMP, type: "COMPONENT", adIds: ["ad2"], children: [] }] });
    expect(errors.map((e) => e.name)).toEqual(["ghost"]);
  });

  test("find-ad-methods by component NAME (PD-14 / F20) and recursive", async () => {
    const r = await run(findAdMethods, ["widget", "--component"]);
    expect(r.envelope?.data).toMatchObject({ resolvedId: COMP, type: "COMPONENT", adIds: ["ad2"] });
    const rec = await run(findAdMethods, [PAGE, "-r"]);
    expect(rec.envelope?.data).toMatchObject({ adIds: ["ad1", "ad2"], errors: [{ name: "ghost" }] });
  });

  test("analyze needs explicit roots (no hardcoded nsm ids) and reads no CWD files", async () => {
    expect((await run(analyze, [])).envelope?.error?.code).toBe("MISSING_INPUT");
    const r = await run(analyze, [PAGE]);
    expect(r.envelope?.data).toMatchObject({ targetIds: [PAGE], uniqueAdIds: ["ad1", "ad2"], compliance: null });
    expect((await run(analyze, [PAGE, "--compliance", "/nonexistent/master.txt"])).envelope?.error?.code).toBe("MASTER_IDS_FILE_MISSING");
  });

  test("show -r reports unresolvable components (PD-19) and direct children skip the root (PD-25)", async () => {
    const r = await run(show, [COMP, "-r"]);
    expect(r.envelope?.data).toMatchObject({ summary: { entityType: "COMPONENT", directChildComponents: [{ name: "widget" }] } });
    const p = await run(show, [PAGE, "-r", "--force"]);
    expect((p.envelope?.data as any).recursive.errors.map((e: any) => e.name)).toEqual(["ghost"]);
  });
});

describe("page finder (F19 / PD-27)", () => {
  const comp = (id: string, name: string, status: string, referenceId: string) => ({ id, name, status, referenceId, updatedAt: 0, url: "" });
  const index: PageFinderIndex = {
    env: ENV,
    generatedAt: 0,
    pages: [],
    components: [
      comp("d1", "student_ellStatus", "DRAFT", "p1"),
      comp("p1", "student_ellStatus", "PUBLISHED", "d1"),
      comp("p2", "orphan_status", "PUBLISHED", "gone"),
      ...Array.from({ length: 30 }, (_, i) => comp(`x${i}`, `status_${i}`, "DRAFT", "")),
    ],
    pageCount: 0,
    componentCount: 33,
  };

  test("a draft/published component pair is one row", () => {
    expect(collapsePairs(index.components).map((c) => c.id).slice(0, 2)).toEqual(["d1", "p2"]);
    const { matches } = searchPageIndex(index, "student_ellStatus", 20);
    expect(matches.map((m) => m.id)).toEqual(["d1"]);
  });

  test("--limit caps the rows; the total is counted before the cap", () => {
    const { matches, total } = searchPageIndex(index, "status", 5);
    expect(matches).toHaveLength(5);
    expect(total).toBe(32);
  });
});

describe("diff engine (PD-11)", () => {
  const base = parsePage(page(PAGE, cleanInner({ httpRequests: { generated: [], userDefined: [exec("ad1", "h1")] } })));
  test.each([
    ["HTTP url", { httpRequests: { update: [{ callId: "h1", request: { url: "/other" } }] } }, (d: any) => d.httpRequests.changed, ["h1"]],
    ["node prop", { elements: { operations: [{ key: "layout.children[0].props.className", value: "x", operation: "CREATE", dataType: "STRING" }] } }, (d: any) => d.nodesChanged, ["n1"]],
    ["variable type", { variables: { update: [{ name: "greeting", type: "Any" }] } }, (d: any) => d.variables.changed, ["greeting"]],
  ] as const)("a change in %s is reported (used to be identical:true)", (_label, overlay, pick, expected) => {
    const d = diffPages(base, applyOverlay(base, overlay as any));
    expect(pick(d)).toEqual(expected);
    expect(isIdentical(d)).toBe(false);
  });

  test("derived from/filterFn changes and other config keys are reported", () => {
    const withDerived = parsePage(page(PAGE, cleanInner({ variables: { generated: [], userDefined: [{ name: "d", from: ["a"], spec: "s" }], derived: [] } })));
    const d = diffPages(withDerived, applyOverlay(withDerived, { derived: { update: [{ name: "d", from: ["b"] }] } }));
    expect(d.derived.changed).toEqual(["d"]);
    const other = parsePage(page(PAGE, { ...cleanInner(), inputs: ["z"] }));
    expect(diffPages(base, other).otherChanged).toEqual(["inputs"]);
    expect(isIdentical(diffPages(base, base))).toBe(true);
  });
});
