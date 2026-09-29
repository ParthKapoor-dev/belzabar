// Property tests over real PD pages/components.
//
// Fixtures: tests/fixtures/real/<id>.json — raw GET /rest/api/pagedesigner/pages/{id}
// bodies, sanitized, captured by scripts/fixtures/capture.ts (see manifest.json).
// Includes both "Add Student" draft/published pairs (duplicate names)
// and "Student Application" 4cba8f39… (475 vars, ~585 KB).
//
// A full save of an unedited page is lossless on every real page, and
// a full save of an edited page differs from the original ONLY at the edit.

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "fs";
import { parsePage } from "../../lib/parser/index";
import { serializeFull } from "../../lib/serialize/full";
import { planSave } from "../../lib/serialize/index";
import { inferEntityType } from "../../lib/parser/index";
import { resolveDraftTarget } from "../../lib/draft-guard";
import type { RawPageResponse } from "../../lib/types/wire";
import { REAL_DIR, REAL_FILES, loadReal } from "./helpers/real";


/** Leaf-level structural diff; returns "path: before -> after" strings. */
function diffPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) diffPaths(ao[k], bo[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return out;
}

describe("real PD fixtures", () => {
  test("inventory: ~15 pages/components, manifest covers every file", () => {
    expect(REAL_FILES.length).toBe(15);
    const manifest = JSON.parse(readFileSync(`${REAL_DIR}/manifest.json`, "utf8")) as Array<{ file: string; env: string; endpoint: string }>;
    expect(manifest.map((m) => m.file).sort()).toEqual(REAL_FILES);
    for (const m of manifest) {
      expect(m.env).toBe("acme-dev");
      expect(m.endpoint).toBe(`/rest/api/pagedesigner/pages/${m.file.replace(/\.json$/, "")}`);
    }
  });

  test("no fixture is over 1 MB (largest is Student Application)", () => {
    for (const f of REAL_FILES) expect(statSync(`${REAL_DIR}/${f}`).size).toBeLessThan(1024 * 1024);
  });
});

describe("parsePage on every real page", () => {
  for (const f of REAL_FILES) {
    const raw = loadReal(f);
    test(`${raw.id.slice(0, 10)} ${raw.name}: parses with no warnings, identity intact`, () => {
      const page = parsePage(raw);
      expect(page.id).toBe(raw.id);
      expect(page.name).toBe(raw.name);
      expect(page.status).toBe(raw.status as "DRAFT" | "PUBLISHED");
      expect(page.parseWarnings).toEqual([]);
      const inner = JSON.parse(raw.configuration!);
      // Real editor output keeps derived vars (entries with `from`) in userDefined.
      const ud = (inner.variables?.userDefined ?? []) as Array<{ from?: unknown }>;
      expect(page.variables.length).toBe(ud.filter((v) => !Array.isArray(v.from)).length);
      expect(page.derived.length).toBe(ud.filter((v) => Array.isArray(v.from)).length + (inner.variables?.derived ?? []).length);
      expect(page.derived.every((d) => d.location === "userDefined")).toBe(true);
    });
  }

  test("Student Application is the large one: 475 userDefined entries (287 vars + 188 derived), 39 HTTP calls", () => {
    const page = parsePage(loadReal("4cba8f39eb92d136694dadc4e7f2a811.json"));
    expect(page.variables.length).toBe(287);
    expect(page.derived.length).toBe(188);
    expect(page.httpRequests.length).toBe(39);
  });
});

describe("entity type comes from the server", () => {
  test("isComponent rows are COMPONENT; routed pages are PAGE even with an isSymbol root", () => {
    for (const f of REAL_FILES) {
      const raw = loadReal(f);
      const inner = JSON.parse(raw.configuration!);
      const expected = raw.isComponent === true ? "COMPONENT" : "PAGE";
      expect(`${raw.name}:${parsePage(raw).entityType}`).toBe(`${raw.name}:${expected}`);
      expect(inferEntityType(raw)).toBe(expected);
      if (expected === "PAGE" && inner.layout?.isSymbol === true) {
        // e.g. both "Add Student" pages: the old shape-based guess said COMPONENT
        expect(typeof raw.relativeRoute).toBe("string");
      }
    }
  });

  test("a history version body (no isComponent) is typed by its route", () => {
    const { isComponent: _c, ...page } = loadReal("4bde22f76091a82364fda322eeeda597.json");
    expect(inferEntityType(page as RawPageResponse)).toBe("PAGE");
    const { isComponent: _d, ...comp } = loadReal("43488abaf65c8efc95ad880a346f38af.json");
    expect(inferEntityType(comp as RawPageResponse, JSON.parse(comp.configuration!))).toBe("COMPONENT");
  });
});

describe("full-save serialization", () => {
  for (const f of REAL_FILES) {
    const raw = loadReal(f);
    const label = `${raw.id.slice(0, 10)} ${raw.name}`;
    test(`${label}: unedited full save is lossless`, () => {
      expect(diffPaths(JSON.parse(raw.configuration!), JSON.parse(serializeFull(parsePage(raw))))).toEqual([]);
    });
  }

  test("an edited full save differs from the original only at the edit (every page)", () => {
    for (const f of REAL_FILES) {
      const raw = loadReal(f);
      const page = parsePage(raw);
      const plan = planSave(page, { variables: { add: [{ name: "__belz_probe", type: "String", initialValue: "x" }] }, styles: { replace: "/*probe*/" } });
      expect(plan.strategy).toBe("full");
      if (plan.strategy !== "full") continue;
      const before = JSON.parse(raw.configuration!);
      const after = JSON.parse(plan.configurationString);
      const d = diffPaths(before, after).map((p) => p.split(":")[0]);
      const n = (before.variables?.userDefined ?? []).length;
      expect(d.sort()).toEqual([`variables.userDefined.${n}`, "styles"].filter((p) => p !== "styles" || before.styles !== "/*probe*/").sort());
    }
  });
});

describe("duplicate-name 'Add Student' pairs on the real wire", () => {
  const PUB_A = "4bde22f76091a82364fda322eeeda597";
  const DRAFT_A = "4440a1a4628001dfb1b79aaec9dd55fe";
  const PUB_B = "48ac453ee33bbe32f0248075df59ec71";
  const DRAFT_B = "45f7671e3c51c7247e12a640e3fb6d85";
  const deps = { fetchPage: async (id: string) => (REAL_FILES.includes(`${id}.json`) ? loadReal(`${id}.json`) : null) };

  test("all four rows share the name; referenceIds cross-link each pair", () => {
    for (const id of [PUB_A, DRAFT_A, PUB_B, DRAFT_B]) expect(loadReal(`${id}.json`).name).toBe("Add Student");
    expect(loadReal(`${PUB_A}.json`).referenceId).toBe(DRAFT_A);
    expect(loadReal(`${DRAFT_A}.json`).referenceId).toBe(PUB_A);
    expect(loadReal(`${PUB_B}.json`).referenceId).toBe(DRAFT_B);
    expect(loadReal(`${DRAFT_B}.json`).referenceId).toBe(PUB_B);
  });

  test("resolveDraftTarget follows referenceId for both published rows", async () => {
    for (const [pub, draft] of [[PUB_A, DRAFT_A], [PUB_B, DRAFT_B]] as const) {
      const r = await resolveDraftTarget(pub, deps);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.draftId).toBe(draft);
        expect(r.publishedId).toBe(pub);
      }
    }
  });
});
