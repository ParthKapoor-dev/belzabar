// Property tests over real sems-dev PD pages/components (Stage 1).
//
// Fixtures: tests/fixtures/real/<id>.json — raw GET /rest/api/pagedesigner/pages/{id}
// bodies, sanitized, captured by scripts/fixtures/capture.ts (see manifest.json).
// Includes both "Add Student" draft/published pairs (duplicate names, PD-1/PD-7)
// and "Student Application" 4cba8f39… (475 vars, ~585 KB).
//
// PD-22 (full save is lossy) is recorded per page as test.todo with a diff
// summary; the todo body holds the real assertion, fixed in Stage 6.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { parsePage } from "../../lib/parser/index";
import { serializeFull } from "../../lib/serialize/full";
import { resolveDraftTarget } from "../../lib/draft-guard";
import type { RawPageResponse } from "../../lib/types/wire";

const DIR = `${import.meta.dir}/../fixtures/real`;
const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
const load = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as RawPageResponse & Record<string, any>;

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

/** "variables.userDefined[].initialValue ×12, inputs ×1" */
function summarize(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const k = p.split(":")[0]!.replace(/\.\d+(?=\.|$)/g, "[]");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} ×${n}`).join(", ");
}

describe("real PD fixtures", () => {
  test("inventory: ~15 pages/components, manifest covers every file", () => {
    expect(files.length).toBe(15);
    const manifest = JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8")) as Array<{ file: string; env: string; endpoint: string }>;
    expect(manifest.map((m) => m.file).sort()).toEqual(files);
    for (const m of manifest) {
      expect(m.env).toBe("sems-dev");
      expect(m.endpoint).toBe(`/rest/api/pagedesigner/pages/${m.file.replace(/\.json$/, "")}`);
    }
  });

  test("no fixture is over 1 MB (largest is Student Application)", () => {
    for (const f of files) expect(statSync(`${DIR}/${f}`).size).toBeLessThan(1024 * 1024);
  });
});

describe("parsePage on every real page", () => {
  for (const f of files) {
    const raw = load(f);
    test(`${raw.id.slice(0, 10)} ${raw.name}: parses with no warnings, identity intact`, () => {
      const page = parsePage(raw);
      expect(page.id).toBe(raw.id);
      expect(page.name).toBe(raw.name);
      expect(page.status).toBe(raw.status as "DRAFT" | "PUBLISHED");
      expect(page.parseWarnings).toEqual([]);
      const inner = JSON.parse(raw.configuration!);
      expect(page.variables.length).toBe((inner.variables?.userDefined ?? []).length);
    });
  }

  test("Student Application is the large one: 475 vars, 39 HTTP calls", () => {
    const page = parsePage(load("4cba8f39eb92d136694dadc4e7f2a811.json"));
    expect(page.variables.length).toBe(475);
    expect(page.httpRequests.length).toBe(39);
  });
});

describe("full-save serialization of an unedited page (PD-22)", () => {
  for (const f of files) {
    const raw = load(f);
    const before = JSON.parse(raw.configuration!);
    const after = JSON.parse(serializeFull(parsePage(raw)));
    const d = diffPaths(before, after);
    const label = `${raw.id.slice(0, 10)} ${raw.name}`;
    if (d.length === 0) {
      test(`${label}: lossless`, () => expect(diffPaths(before, JSON.parse(serializeFull(parsePage(raw))))).toEqual([]));
    } else {
      test.todo(`PD-22: ${label}: lossless round-trip — today ${d.length} diffs: ${summarize(d)}`, () => {
        expect(diffPaths(before, JSON.parse(serializeFull(parsePage(raw))))).toEqual([]);
      });
    }
  }

  test("the lossy fields are only the known PD-22 ones (no new kinds of loss)", () => {
    const known = /^(variables\.userDefined\[\]\.initialValue|variables\.derived|inputs|events|helpText)$/;
    for (const f of files) {
      const raw = load(f);
      const d = diffPaths(JSON.parse(raw.configuration!), JSON.parse(serializeFull(parsePage(raw))));
      for (const p of d) expect(p.split(":")[0]!.replace(/\.\d+(?=\.|$)/g, "[]")).toMatch(known);
    }
  });

  test("layout and httpRequests survive the round-trip untouched on every page", () => {
    for (const f of files) {
      const raw = load(f);
      const before = JSON.parse(raw.configuration!);
      const after = JSON.parse(serializeFull(parsePage(raw)));
      expect(after.layout).toEqual(before.layout);
      expect(after.httpRequests ?? null).toEqual(before.httpRequests ?? null);
      expect(after.styles ?? "").toEqual(before.styles ?? "");
    }
  });
});

describe("duplicate-name 'Add Student' pairs on the real wire (PD-1/PD-7)", () => {
  const PUB_A = "4bde22f76091a82364fda322eeeda597";
  const DRAFT_A = "4440a1a4628001dfb1b79aaec9dd55fe";
  const PUB_B = "48ac453ee33bbe32f0248075df59ec71";
  const DRAFT_B = "45f7671e3c51c7247e12a640e3fb6d85";
  const deps = { fetchPage: async (id: string) => (files.includes(`${id}.json`) ? load(`${id}.json`) : null) };

  test("all four rows share the name; referenceIds cross-link each pair", () => {
    for (const id of [PUB_A, DRAFT_A, PUB_B, DRAFT_B]) expect(load(`${id}.json`).name).toBe("Add Student");
    expect(load(`${PUB_A}.json`).referenceId).toBe(DRAFT_A);
    expect(load(`${DRAFT_A}.json`).referenceId).toBe(PUB_A);
    expect(load(`${PUB_B}.json`).referenceId).toBe(DRAFT_B);
    expect(load(`${DRAFT_B}.json`).referenceId).toBe(PUB_B);
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
