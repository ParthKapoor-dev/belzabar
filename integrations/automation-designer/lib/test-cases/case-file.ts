// AD test cases: the UI wire encoding ↔ a git-friendly case file (7.7 / 7.13).
//
// Wire (what `POST /chain/testcases/{chainUuid}` takes and the suite GET
// returns — api-endpoints.md §8.2, live 2026-09-29):
//   { name, description, inputs: [{fieldCode, value, defaultValue}],
//     assertions: [{mode:"advance", conditionExpression:"#{out} eq 'x'", conditions:null}] }
//   value/defaultValue are JSON TEXT of a wrapper {"value": <actual>} (plus
//   `properties` for some OBJECT/ARRAY inputs). The store is jsonb, so the
//   text comes back re-spaced (`{"value": "x"}`): compare decoded, never bytes.
//   `conditions: null` is dropped on read. Server-owned: ids, createdBy/On,
//   updatedBy/On, testCaseId, testSuiteId. `active:false` hides the case from
//   the suite GET (a soft delete), so case files carry no `active`.
//
// Case file (one per test case; stable key order; env-free — no ids):
//   { name, description, inputs: {fieldCode: actual},
//     inputExtras?: {fieldCode: {defaultValue?, wrapper?, raw?}},
//     assertions: [{output, op, expected} | {expression, mode?, conditions?}] }

import { CliError, isObj } from "@belzabar/core";
import { assertionFromWire, assertionToWire, isStructured, type CaseAssertion } from "./expect";

interface InputExtra {
  /** Stored defaultValue, when it differs from the value. */
  defaultValue?: unknown;
  /** Extra wrapper keys besides `value` (e.g. `properties`). */
  wrapper?: Record<string, unknown>;
  /** The stored value is not a `{"value": …}` wrapper: `inputs[fc]` is the verbatim text. */
  raw?: true;
}

export interface CaseFile {
  name: string;
  description: string;
  inputs: Record<string, unknown>;
  inputExtras?: Record<string, InputExtra>;
  assertions: CaseAssertion[];
}

type Obj = Record<string, unknown>;

/** Recursively sort object keys (stable files, order-insensitive compare). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}

/** Decode a stored wrapper; `null` when it is not `{"value": …}` JSON text. */
function decodeWrapper(stored: unknown): { value: unknown; wrapper?: Obj } | null {
  if (typeof stored !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isObj(parsed) || !Object.prototype.hasOwnProperty.call(parsed, "value")) return null;
  const { value, ...rest } = parsed;
  return Object.keys(rest).length > 0 ? { value, wrapper: rest } : { value };
}

function encodeWrapper(value: unknown, wrapper?: Obj): string {
  return JSON.stringify({ value, ...(wrapper ?? {}) });
}

/** A test case as the server stores it → the case file. */
export function caseFromWire(wire: unknown): CaseFile {
  const w = isObj(wire) ? wire : {};
  const inputs: Obj = {};
  const extras: Record<string, InputExtra> = {};
  const rows = (Array.isArray(w.inputs) ? w.inputs : []).filter(isObj);
  for (const row of [...rows].sort((a, b) => String(a.fieldCode).localeCompare(String(b.fieldCode)))) {
    const fc = typeof row.fieldCode === "string" ? row.fieldCode : "";
    const dec = decodeWrapper(row.value);
    const extra: InputExtra = {};
    if (dec) {
      inputs[fc] = sortKeys(dec.value);
      if (dec.wrapper) extra.wrapper = sortKeys(dec.wrapper) as Obj;
    } else {
      inputs[fc] = row.value ?? null;
      extra.raw = true;
    }
    if (row.defaultValue !== undefined && row.defaultValue !== null && row.defaultValue !== row.value) {
      const d = decodeWrapper(row.defaultValue);
      const same = dec && d && JSON.stringify(sortKeys(d)) === JSON.stringify(sortKeys(dec));
      if (!same) extra.defaultValue = d ? sortKeys(d.value) : row.defaultValue;
    }
    if (Object.keys(extra).length > 0) extras[fc] = extra;
  }
  const assertions = (Array.isArray(w.assertions) ? w.assertions : []).filter(isObj).map(assertionFromWire);
  const file: CaseFile = {
    name: typeof w.name === "string" ? w.name : "",
    description: typeof w.description === "string" ? w.description : "",
    inputs,
    assertions,
  };
  if (Object.keys(extras).length > 0) file.inputExtras = extras;
  return file;
}

/** The case file → the UI-compatible create/update body. */
export function caseToWire(c: CaseFile): Obj {
  const inputs = Object.keys(c.inputs).sort().map((fc) => {
    const extra = c.inputExtras?.[fc] ?? {};
    const value = extra.raw ? c.inputs[fc] : encodeWrapper(c.inputs[fc], extra.wrapper);
    const defaultValue = extra.defaultValue === undefined ? value : extra.raw ? extra.defaultValue : encodeWrapper(extra.defaultValue, extra.wrapper);
    return { fieldCode: fc, value, defaultValue };
  });
  return { name: c.name, description: c.description, inputs, assertions: c.assertions.map(assertionToWire) };
}

/** Canonical JSON (stable key order) for comparing two case files. */
function canon(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

/** Fields that differ between two case files (`[]` = the same test case). */
export function diffCases(a: CaseFile, b: CaseFile): Array<"name" | "description" | "inputs" | "assertions"> {
  const out: Array<"name" | "description" | "inputs" | "assertions"> = [];
  if (a.name !== b.name) out.push("name");
  if ((a.description ?? "") !== (b.description ?? "")) out.push("description");
  if (canon([a.inputs, a.inputExtras ?? {}]) !== canon([b.inputs, b.inputExtras ?? {}])) out.push("inputs");
  if (canon(a.assertions) !== canon(b.assertions)) out.push("assertions");
  return out;
}

/** Stable, human-diffable file text: fixed top-level order, sorted nested keys, trailing newline. */
export function serializeCaseFile(c: CaseFile): string {
  const out: Obj = {
    name: c.name,
    description: c.description,
    inputs: sortKeys(c.inputs),
  };
  if (c.inputExtras && Object.keys(c.inputExtras).length > 0) out.inputExtras = sortKeys(c.inputExtras);
  out.assertions = c.assertions.map((a) =>
    isStructured(a) ? { output: a.output, op: a.op, expected: a.expected } : sortKeys(a),
  );
  return `${JSON.stringify(out, null, 2)}\n`;
}

const CASE_KEYS = new Set(["name", "description", "inputs", "inputExtras", "assertions"]);

/**
 * Read a case file, or a UI-wire test case (inputs as an array of
 * {fieldCode, value}), into a CaseFile. `source` names the file in errors.
 */
export function parseCaseInput(json: unknown, source: string): CaseFile {
  const bad = (why: string) => new CliError(`${source}: ${why}`, { code: "AD_TESTCASE_INVALID" });
  if (!isObj(json)) throw bad("a test case must be a JSON object");
  if (typeof json.name !== "string" || !json.name.trim()) throw bad("missing \"name\"");
  if (json.active === false) {
    throw bad("\"active\": false hides the case from the suite (the server's soft delete); remove it or delete the case instead");
  }
  if (Array.isArray(json.inputs)) {
    // UI wire body: normalise through the same decoder the fetch-back uses.
    return caseFromWire(json);
  }
  const unknown = Object.keys(json).filter((k) => !CASE_KEYS.has(k) && k !== "active");
  if (unknown.length > 0) throw bad(`unknown key(s) ${unknown.join(", ")} (case files hold ${[...CASE_KEYS].join(", ")})`);
  if (json.inputs !== undefined && !isObj(json.inputs)) throw bad("\"inputs\" must be an object {fieldCode: value} (or a UI array of {fieldCode, value})");
  if (json.assertions !== undefined && !Array.isArray(json.assertions)) throw bad("\"assertions\" must be an array");
  const assertions: CaseAssertion[] = [];
  for (const [i, a] of ((json.assertions as unknown[]) ?? []).entries()) {
    if (!isObj(a)) throw bad(`assertions[${i}] must be an object`);
    if (typeof a.output === "string") {
      const op = a.op ?? "eq";
      if (!["eq", "neq", "gt", "lt", "contains"].includes(String(op))) throw bad(`assertions[${i}].op must be eq, neq, gt, lt or contains`);
      const e = a.expected;
      if (e !== null && !["string", "number", "boolean"].includes(typeof e)) throw bad(`assertions[${i}].expected must be a string, number, boolean or null`);
      assertions.push({ output: a.output, op: op as "eq", expected: e as string });
    } else if (typeof a.expression === "string" || typeof a.conditionExpression === "string") {
      assertions.push(assertionFromWire({ mode: a.mode, conditionExpression: a.expression ?? a.conditionExpression, conditions: a.conditions }));
    } else {
      throw bad(`assertions[${i}] needs {output, op, expected} or {expression}`);
    }
  }
  const file: CaseFile = {
    name: json.name,
    description: typeof json.description === "string" ? json.description : "",
    inputs: (json.inputs as Obj | undefined) ?? {},
    assertions,
  };
  if (isObj(json.inputExtras) && Object.keys(json.inputExtras).length > 0) file.inputExtras = json.inputExtras as Record<string, InputExtra>;
  return file;
}

/** A file name for a case: its name with unsafe characters replaced. */
export function caseFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 150);
  return `${safe || "case"}.json`;
}
