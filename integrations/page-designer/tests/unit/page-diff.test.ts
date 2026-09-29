// diffPages / editSummary must see reorders, moves, every variable
// field and duplicate names (they reported identical:true before), over the
// real "Student Application" fixture.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parsePage } from "../../lib/parser/index";
import { withConfiguration } from "../../lib/serialize/index";
import { diffPages, editSummary, isIdentical } from "../../lib/page-diff";
import type { RawPageResponse } from "../../lib/types/wire";

const REAL = `${import.meta.dir}/../fixtures/real`;
const raw = JSON.parse(readFileSync(`${REAL}/4cba8f39eb92d136694dadc4e7f2a811.json`, "utf8")) as RawPageResponse;
const before = parsePage(raw);

type Inner = { layout: any; variables: { userDefined: any[] } };
function mutate(fn: (inner: Inner) => void) {
  const inner = JSON.parse(JSON.stringify(before.rawConfiguration)) as Inner;
  fn(inner);
  return withConfiguration(before, inner);
}
/** First node with ≥2 children that have ids. */
function parentWithKids(n: any): any {
  if (Array.isArray(n?.children) && n.children.filter((c: any) => c?.id).length >= 2) return n;
  for (const c of n?.children ?? []) {
    const f = parentWithKids(c);
    if (f) return f;
  }
  return null;
}

describe("diffPages sees every structural change", () => {
  test("identical copy → identical", () => {
    expect(isIdentical(diffPages(before, mutate(() => {})))).toBe(true);
  });

  test("child reorder → childrenReordered", () => {
    let parentId = "";
    const after = mutate((i) => {
      const p = parentWithKids(i.layout);
      parentId = p.id;
      p.children.reverse();
    });
    const d = diffPages(before, after);
    expect(isIdentical(d)).toBe(false);
    expect(d.childrenReordered).toContain(parentId);
    expect(editSummary(before, after).childrenReordered).toContain(parentId);
  });

  test("moving a node under another parent → nodesMoved", () => {
    let movedId = "";
    const after = mutate((i) => {
      const p = parentWithKids(i.layout);
      const [moved] = p.children.splice(0, 1);
      movedId = moved.id;
      const target = p.children.find((c: any) => c?.id && Array.isArray(c.children)) ?? p.children[0];
      (target.children ??= []).push(moved);
    });
    expect(diffPages(before, after).nodesMoved).toContain(movedId);
  });

  test.each(["compileType", "description", "variableMetadata", "initial"])("a variable's %s → variables.changed", (field) => {
    let name = "";
    const after = mutate((i) => {
      const v = i.variables.userDefined.find((x) => !x.from);
      name = v.name;
      v[field] = { changed: field };
    });
    expect(diffPages(before, after).variables.changed).toContain(name);
  });

  test("a derived variable's type → derived.changed", () => {
    let name = "";
    const after = mutate((i) => {
      const d = i.variables.userDefined.find((x) => Array.isArray(x.from));
      name = d.name;
      d.type = "SomethingElse";
    });
    expect(diffPages(before, after).derived.changed).toContain(name);
  });

  test("a duplicate variable name is not dropped (name#2)", () => {
    const after = mutate((i) => {
      const v = i.variables.userDefined.find((x) => !x.from);
      i.variables.userDefined.push({ ...v, initialValue: "dup" });
    });
    const d = diffPages(before, after);
    expect(d.variables.added.some((n) => n.endsWith("#2"))).toBe(true);
  });
});
