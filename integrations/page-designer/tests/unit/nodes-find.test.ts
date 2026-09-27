// Stage 7 (7.8 / 7.9): `pd show --find`, node-id overlay ops
// (nodes.update / insert / remove) through the save pipeline on real
// fixtures, and the compact read outputs (show sections, page-deps summary,
// find list rows).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import show from "../../commands/show/index";
import save from "../../commands/save/index";
import pageDeps, { summarizeDependencies } from "../../commands/page-deps/index";
import find from "../../commands/find/index";
import { findNodes } from "../../lib/extract";
import { parsePage } from "../../lib/parser/index";
import { applyOverlay, planSave, replayOperations } from "../../lib/serialize/index";
import { rawNodes } from "../../lib/serialize/nodes";
import { getPathForTest } from "./helpers/paths";
import { validateEdit, partitionBySeverity } from "../../lib/validator/index";
import { ENV, innerOf, page, startFakePd, type FakePd } from "./helpers/fake-pd";
import type { Overlay } from "../../lib/types/common";
import type { RawPageResponse } from "../../lib/types/wire";

const REAL = `${import.meta.dir}/../fixtures/real`;
const loadReal = (id: string) => JSON.parse(readFileSync(`${REAL}/${id}.json`, "utf8")) as RawPageResponse;
const STUDENT_APP = "4cba8f39eb92d136694dadc4e7f2a811";
const ADD_STUDENT = "4440a1a4628001dfb1b79aaec9dd55fe";

/** The inner config with the node at `path` removed from consideration (for "nothing else changed"). */
function withoutNode(inner: unknown, path: string): unknown {
  const clone = JSON.parse(JSON.stringify(inner));
  const node = getPathForTest(clone, path) as Record<string, unknown>;
  for (const k of Object.keys(node)) delete node[k];
  return clone;
}

describe("findNodes (show --find)", () => {
  const p = parsePage(loadReal(STUDENT_APP));

  test("an exact id returns that node with a path that resolves to it in the raw config", () => {
    const any = rawNodes(p.rawConfiguration as never)[7]!;
    const id = any.node.id as string;
    const [m, ...rest] = findNodes(p, id);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ id, path: any.path, match: "id" });
    expect(getPathForTest(p.rawConfiguration, m!.path)).toEqual(any.node);
    // parentId/index locate it for nodes.insert
    const parent = findNodes(p, m!.parentId!)[0]!;
    expect(getPathForTest(p.rawConfiguration, `${parent.path}.children[${m!.index}]`)).toEqual(any.node);
  });

  test("a component name returns every node of it; text matches labels; a button is labelled by its span", () => {
    const dialogs = findNodes(p, "exp-layout-dialog");
    expect(dialogs.length).toBeGreaterThan(0);
    expect(dialogs.every((d) => d.component === "exp-layout-dialog" && d.match === "component")).toBe(true);
    const save = findNodes(p, "labelSaveAndExit");
    expect(save.some((m) => m.component === "button" && m.label === "{%labelSaveAndExit%}")).toBe(true);
    expect(findNodes(p, "no-such-text-anywhere-xyz")).toEqual([]);
  });
});

describe("node-id overlay ops (real Student Application, 546 KB)", () => {
  const before = parsePage(loadReal(STUDENT_APP));
  const target = findNodes(before, "labelSaveAndExit").find((m) => m.component === "span")!;

  test("nodes.update → partial ops at the node's path; replay == applyOverlay; nothing else changes", () => {
    const overlay: Overlay = { nodes: { update: [{ id: target.id, props: { innerHTML: "Save &amp; Exit", className: "x" } }] } };
    const plan = planSave(before, overlay);
    expect(plan.strategy).toBe("partial");
    if (plan.strategy !== "partial") return;
    expect(plan.operations.map((o) => [o.key, o.dataType])).toEqual([
      [`${target.path}.props.innerHTML`, "STRING"],
      [`${target.path}.props.className`, "STRING"],
    ]);
    const replayed = replayOperations(before.rawConfiguration as never, plan.operations);
    expect(isDeepStrictEqual(replayed, plan.patched.rawConfiguration)).toBe(true);
    expect(isDeepStrictEqual(withoutNode(plan.patched.rawConfiguration, target.path), withoutNode(before.rawConfiguration, target.path))).toBe(true);
    expect((getPathForTest(plan.patched.rawConfiguration, target.path) as { props: Record<string, unknown> }).props.innerHTML).toBe("Save &amp; Exit");
    expect(partitionBySeverity(validateEdit(before, plan.patched)).errors).toEqual([]);
  });

  test("a null deletes the key and forces a full save", () => {
    const plan = planSave(before, { nodes: { update: [{ id: target.id, props: { isVisible: null } }] } });
    expect(plan).toMatchObject({ strategy: "full", fallbackReason: "nodes.update removes a key (null)" });
    expect((getPathForTest(plan.patched.rawConfiguration, target.path) as { props: Record<string, unknown> }).props).not.toHaveProperty("isVisible");
  });

  test("insert: full save, ids generated in the editor format and stable across plans, placed at index", () => {
    const parentId = target.parentId!;
    const overlay: Overlay = { nodes: { insert: [{ parentId, index: 0, node: { name: "span", props: { innerHTML: "Hi" }, children: [{ name: "b" }] } }] } };
    const a = planSave(before, overlay);
    const b = planSave(before, overlay);
    expect(a).toMatchObject({ strategy: "full", fallbackReason: "nodes.insert" });
    const parentPath = findNodes(before, parentId)[0]!.path;
    const inserted = getPathForTest(a.patched.rawConfiguration, `${parentPath}.children[0]`) as Record<string, unknown>;
    expect(inserted.id).toMatch(/^__node_id_\d+_\d+_\d+_\d+$/);
    expect(inserted._elementId).toMatch(/^__element_id_\d+_\d+_\d+_\d+$/);
    expect(((inserted.children as Array<Record<string, unknown>>)[0]!).id).toMatch(/^__node_id_/);
    expect(a.patched.rawConfiguration).toEqual(b.patched.rawConfiguration);
    const errors = partitionBySeverity(validateEdit(before, a.patched)).errors;
    expect(errors).toEqual([]);
  });

  test("remove deletes the subtree; elements.operations paths refer to the unedited tree", () => {
    const siblings = findNodes(before, target.parentId!)[0]!;
    const plan = planSave(before, {
      elements: { operations: [{ key: `${target.path}.props.title`, value: "t", operation: "CREATE", dataType: "STRING" }] },
      nodes: { remove: [target.id] },
    });
    expect(plan).toMatchObject({ strategy: "full", fallbackReason: "nodes.remove" });
    expect(findNodes(plan.patched, target.id)).toEqual([]);
    expect(findNodes(plan.patched, siblings.id)).toHaveLength(1);
  });

  test("unknown / ambiguous ids, the root, id clashes and unknown sections are refused (PD_OVERLAY_INVALID)", () => {
    const bad: Overlay[] = [
      { nodes: { update: [{ id: "nope", props: { a: 1 } }] } },
      { nodes: { update: [{ id: target.id }] } },
      { nodes: { remove: [before.layout.nodeId] } },
      { nodes: { insert: [{ parentId: target.parentId!, node: { id: target.id, name: "span" } }] } },
      { nodes: { insert: [{ parentId: target.parentId!, index: 999, node: { name: "span" } }] } },
      { nodes: { insert: [{ parentId: target.parentId!, node: { props: {} } }] } },
      { node: { update: [] } } as unknown as Overlay,
    ];
    for (const o of bad) expect(() => applyOverlay(before, o)).toThrow(expect.objectContaining({ code: "PD_OVERLAY_INVALID" }));
    const dup = parsePage(page("x", {
      __version: 5,
      layout: { id: "r", name: "div", unSelectable: true, children: [{ id: "same", name: "span" }, { id: "same", name: "span" }] },
      variables: { generated: [], userDefined: [] },
    }));
    expect(() => applyOverlay(dup, { nodes: { update: [{ id: "same", props: { a: 1 } }] } })).toThrow(/not unique/);
  });
});

describe("commands over the fake PD server", () => {
  let pd: FakePd;
  const dir = scratchDir("belz-pd-nodes-");
  const run = (cmd: Parameters<typeof runCommand>[0], argv: string[]) => runCommand(cmd, argv, { env: ENV });
  beforeEach(() => {
    rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
    rmSync(join(BELZ_CONFIG_DIR, "cache", "page-finder"), { recursive: true, force: true });
    const real = loadReal(ADD_STUDENT);
    pd = startFakePd([
      { ...real, referenceId: null } as RawPageResponse,
      page("c0000000000000000000000000000001", { __version: 5, layout: { id: "r", name: "div", isSymbol: true, children: [] } }, { name: "comp-a", isComponent: true, relativeRoute: undefined }),
    ]);
  });
  afterEach(() => pd.restore());

  test("show --find returns compact matches and an identity-only summary", async () => {
    const r = await run(show, [ADD_STUDENT, "--find", "h1", "--force"]);
    expect(r.envelope?.ok).toBe(true);
    const data = r.envelope!.data as { summary: Record<string, unknown>; find: { total: number; matches: Array<Record<string, unknown>> } };
    expect(Object.keys(data.summary).sort()).toEqual(["draftId", "entityType", "name", "publishedId", "resolvedId", "status", "versionId"]);
    expect(data.find.total).toBeGreaterThan(0);
    expect(data.find.matches[0]).toMatchObject({ component: "h1", match: "component", path: expect.stringMatching(/^layout\.children\[/) });
    expect(data).not.toHaveProperty("request");
  });

  test("show --vars / --http default rows drop empty and heavy fields; --fields all restores them", async () => {
    const compact = (await run(show, [ADD_STUDENT, "--vars", "--http", "--force"])).envelope!.data as {
      vars: { userDefined: Array<Record<string, unknown>>; derived: Array<Record<string, unknown>> };
      http: Array<Record<string, unknown>>;
    };
    for (const d of compact.vars.derived) expect(Object.keys(d).every((k) => ["name", "from", "sideEffect"].includes(k))).toBe(true);
    for (const h of compact.http) expect(h).not.toHaveProperty("serviceUuid");
    const all = (await run(show, [ADD_STUDENT, "--vars", "--fields", "all", "--force"])).envelope!.data as typeof compact;
    expect(all.vars.derived.some((d) => typeof d.spec === "string")).toBe(true);
    const bad = await run(show, [ADD_STUDENT, "--vars", "--fields", "name,bogus"]);
    expect(bad.envelope?.error?.code).toBe("INVALID_VALUE");
  });

  test("save --dry-run with a node-id overlay on a real page plans a partial save at the node path", async () => {
    const p = parsePage(loadReal(ADD_STUDENT));
    const node = findNodes(p, "button")[0]!;
    const f = join(dir, "nodes.json");
    writeFileSync(f, JSON.stringify({ nodes: { update: [{ id: node.id, props: { title: "Add" } }] } }));
    const r = await run(save, [ADD_STUDENT, "--overlay", f, "--dry-run"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ strategy: "partial", operationsCount: 1, operationsPreview: [{ key: `${node.path}.props.title` }] });
  });

  test("save --yes applies an insert as a full save and the stored page has the node", async () => {
    const p = parsePage(loadReal(ADD_STUDENT));
    const parent = p.layout.children[0]!;
    const f = join(dir, "ins.json");
    writeFileSync(f, JSON.stringify({ nodes: { insert: [{ parentId: parent.nodeId, node: { id: "belz_tst_new", name: "span", props: { innerHTML: "x" } } }] } }));
    const r = await run(save, [ADD_STUDENT, "--overlay", f, "--yes"]);
    expect(r.envelope?.ok).toBe(true);
    expect(r.envelope?.data).toMatchObject({ strategy: "full", fullSaveReason: "nodes.insert", verify: { status: "match" } });
    const stored = parsePage(pd.pages.get(ADD_STUDENT)!);
    expect(findNodes(stored, "belz_tst_new")[0]).toMatchObject({ parentId: parent.nodeId });
    expect(innerOf(pd.pages.get(ADD_STUDENT)!).layout).toBeDefined();
  });

  test("page-deps: a summary by default, the raw graph only with --full", async () => {
    const PUB = "a0000000000000000000000000000009";
    pd.pages.set(PUB, page(PUB, { __version: 5, layout: { id: "r", name: "div", unSelectable: true, children: [] } }, { status: "PUBLISHED", referenceId: "b0000000000000000000000000000009" }));
    pd.pages.set("b0000000000000000000000000000009", page("b0000000000000000000000000000009", { __version: 5, layout: { id: "r", name: "div", unSelectable: true, children: [] } }, { referenceId: PUB }));
    pd.deps[PUB] = {
      [PUB]: { id: PUB, name: "P", status: "PUBLISHED", referenceId: "b0000000000000000000000000000009", configuration: "x".repeat(1000) },
      [`${PUB}__translated_phrases`]: [{ key: "page.d" }, { key: "page.d" }],
      [`${PUB}__original_phrases`]: [{}],
      "comp-a": { id: "c1", name: "comp-a", status: "PUBLISHED", isComponent: true, configuration: "{}" },
      "comp-a__translated_phrases": [{}],
    };
    const r = await run(pageDeps, [PUB]);
    expect(r.envelope?.error ?? null).toBeNull();
    const data = r.envelope!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("dependencyJSON");
    expect(data.counts).toEqual({ entities: 2, translatedPhrases: 3, originalPhrases: 1 });
    expect((data.entities as Array<{ key: string; configBytes: number }>)[0]).toMatchObject({ key: PUB, configBytes: 1000, translatedPhrases: 2 });
    const full = await run(pageDeps, [PUB, "--full"]);
    expect(Object.keys((full.envelope!.data as { dependencyJSON: object }).dependencyJSON)).toHaveLength(5);
  });

  test("find list rows drop url/updatedAt unless --full", async () => {
    const r = await run(find, ["list", "--refresh"]);
    expect(r.envelope?.ok).toBe(true);
    const rows = (r.envelope!.data as { pages: Array<Record<string, unknown>> }).pages;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).not.toHaveProperty("url");
    expect(r.envelope!.data).not.toHaveProperty("request");
    const full = await run(find, ["list", "--full"]);
    expect((full.envelope!.data as { pages: Array<Record<string, unknown>> }).pages[0]).toHaveProperty("url");
  });
});

describe("summarizeDependencies", () => {
  test("style components with no phrase arrays still get a row; the queried entity is first", () => {
    const rows = summarizeDependencies({ b: { name: "b" }, a: { name: "a" }, "a__translated_phrases": [1, 2] }, "b");
    expect(rows.map((r) => [r.key, r.translatedPhrases, r.originalPhrases])).toEqual([["b", 0, 0], ["a", 2, 0]]);
  });
});
