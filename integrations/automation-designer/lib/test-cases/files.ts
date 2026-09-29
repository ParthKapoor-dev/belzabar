// On-disk layout for exported test cases — built to live in its own
// git repository (the team's unit-test repo), so nothing in it is tied to
// belz or to one environment's ids:
//
//   <root>/<Category>/<method>/
//     method.json           {name, category, uuids: {<env>: <chainUuid>}, inputs: {key: type}, outputs: [key]}
//     cases/<case>.json     one test case per file (case-file.ts: stable key order, decoded values)
//
// `uuids` maps env → the chain the suite is attached to, so one directory
// syncs to several environments (`sync --env X` picks uuids[X]).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { CliError, type JsonInputErrors, readJsonInputSync } from "@belzabar/core";
import { caseFileName, parseCaseInput, serializeCaseFile, type CaseFile } from "./case-file";

export interface MethodMeta {
  name: string;
  category: string | null;
  uuids: Record<string, string>;
  inputs: Record<string, string>;
  outputs: string[];
}

const METHOD_FILE = "method.json";
const CASES_DIR = "cases";

/** A directory-name segment: path separators and control characters replaced. */
function safeSegment(s: string): string {
  const out = s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^\.+/, "_").trim();
  return out || "_";
}

export function methodDirFor(root: string, category: string | null, name: string): string {
  return join(root, safeSegment(category ?? "_uncategorized"), safeSegment(name));
}

function serializeMethodMeta(m: MethodMeta): string {
  const uuids: Record<string, string> = {};
  for (const k of Object.keys(m.uuids).sort()) uuids[k] = m.uuids[k]!;
  const inputs: Record<string, string> = {};
  for (const k of Object.keys(m.inputs).sort()) inputs[k] = m.inputs[k]!;
  return `${JSON.stringify({ name: m.name, category: m.category, uuids, inputs, outputs: [...m.outputs].sort() }, null, 2)}\n`;
}

/** Any read or parse failure of `path` is INVALID_JSON. */
function notJson(path: string): JsonInputErrors {
  const invalid = (err: unknown) => new CliError(`${path} is not valid JSON: ${String(err)}`, { code: "INVALID_JSON" });
  return { unreadable: invalid, invalid };
}

export function readMethodMeta(dir: string): MethodMeta | null {
  const p = join(dir, METHOD_FILE);
  if (!existsSync(p)) return null;
  const j = readJsonInputSync(p, notJson(p));
  const o = (j ?? {}) as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : "",
    category: typeof o.category === "string" ? o.category : null,
    uuids: (o.uuids && typeof o.uuids === "object" ? o.uuids : {}) as Record<string, string>,
    inputs: (o.inputs && typeof o.inputs === "object" ? o.inputs : {}) as Record<string, string>,
    outputs: Array.isArray(o.outputs) ? o.outputs.filter((x): x is string => typeof x === "string") : [],
  };
}

interface LoadedCase {
  path: string;
  file: CaseFile;
}

/** Every `cases/*.json` in a method directory, parsed. Duplicate names are an error. */
export function readCaseFiles(dir: string): LoadedCase[] {
  const casesDir = join(dir, CASES_DIR);
  if (!existsSync(casesDir)) {
    throw new CliError(`No ${CASES_DIR}/ directory in ${dir} (expected ${dir}/${CASES_DIR}/<case>.json).`, { code: "AD_TESTCASE_DIR_INVALID" });
  }
  const out: LoadedCase[] = [];
  for (const f of readdirSync(casesDir).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(casesDir, f);
    const j = readJsonInputSync(path, notJson(path));
    out.push({ path, file: parseCaseInput(j, path) });
  }
  const seen = new Map<string, string>();
  for (const c of out) {
    const prev = seen.get(c.file.name);
    if (prev) throw new CliError(`Two case files share the name '${c.file.name}': ${prev} and ${c.path}.`, { code: "AD_TESTCASE_DUPLICATE_NAME" });
    seen.set(c.file.name, c.path);
  }
  return out;
}

export interface WriteResult {
  written: string[];
  unchanged: string[];
  /** Case files on disk whose case is not in the export (removed with prune). */
  stale: string[];
  removed: string[];
}

/**
 * Write method.json + one file per case. Existing case files are matched by
 * the case name inside them (not the file name), so renamed files keep their
 * path; files for cases no longer on the server are `stale` (deleted with prune).
 */
export function writeMethodDir(dir: string, meta: MethodMeta, cases: CaseFile[], prune: boolean): WriteResult {
  const casesDir = join(dir, CASES_DIR);
  mkdirSync(casesDir, { recursive: true });
  const res: WriteResult = { written: [], unchanged: [], stale: [], removed: [] };

  const existingByName = new Map<string, string>();
  const unreadable: string[] = [];
  for (const f of readdirSync(casesDir).filter((n) => n.endsWith(".json"))) {
    const p = join(casesDir, f);
    try {
      const j = JSON.parse(readFileSync(p, "utf-8")) as { name?: unknown };
      if (typeof j.name === "string" && !existingByName.has(j.name)) existingByName.set(j.name, p);
      else unreadable.push(p);
    } catch {
      unreadable.push(p);
    }
  }

  const put = (path: string, text: string) => {
    if (existsSync(path) && readFileSync(path, "utf-8") === text) res.unchanged.push(path);
    else {
      writeFileSync(path, text);
      res.written.push(path);
    }
  };
  put(join(dir, METHOD_FILE), serializeMethodMeta(meta));

  // Files that already hold another case (or are unreadable) are never overwritten by a new case.
  const occupied = new Set([...existingByName.values(), ...unreadable]);
  const taken = new Set<string>();
  const keep = new Set<string>();
  for (const c of [...cases].sort((a, b) => a.name.localeCompare(b.name))) {
    let path = existingByName.get(c.name);
    if (!path) {
      const base = caseFileName(c.name).replace(/\.json$/, "");
      let n = 1;
      path = join(casesDir, `${base}.json`);
      while (taken.has(path) || occupied.has(path)) {
        n += 1;
        path = join(casesDir, `${base}__${n}.json`);
      }
    }
    taken.add(path);
    keep.add(path);
    put(path, serializeCaseFile(c));
  }
  for (const p of [...existingByName.values(), ...unreadable]) {
    if (keep.has(p)) continue;
    res.stale.push(p);
    if (prune) {
      rmSync(p);
      res.removed.push(p);
    }
  }
  return res;
}
