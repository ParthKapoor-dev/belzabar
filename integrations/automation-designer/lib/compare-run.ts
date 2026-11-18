// `ad test --compare-published`: is a draft run the same as the published run?
//
// Two runs are identical when they have the same status, the same HTTP status, fail at the
// same step with the same error, and (unless both failed that same way: then the outputs are
// partial and not compared) equal outputs. Outputs are compared after the caller's
// normalisation: `--ignore <path>` drops a value (a timestamp), `--ignore-order` sorts every
// list (the same rows in another order).
//
// Ignore paths, like `--expect`'s left-hand side:
//   out            the whole output          out.a.b / out[0].b   one value inside it
//   out[].b        b in every item of a list *.updatedAt          that key at any depth, in every output

import { CliError, isObj } from "@belzabar/core";
import { canonical, diffOutputs, type OutputDifference, type TestRun } from "./test-run";

export interface CompareOptions {
  ignore: IgnorePath[];
  ignoreOrder: boolean;
}

type Seg = string | number | "[]";

/** A parsed `--ignore` path. */
interface IgnorePath {
  source: string;
  /** `*`: the key at any depth of every output. */
  anyDepthKey?: string;
  output?: string;
  path: Seg[];
}

export function parseIgnorePath(source: string): IgnorePath {
  const any = /^\*\.([A-Za-z0-9_$-]+)$/.exec(source.trim());
  if (any) return { source, anyDepthKey: any[1]!, path: [] };
  const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_$-]+|\[\d*\])*)$/.exec(source.trim());
  if (!m) {
    throw new CliError(`Invalid --ignore path '${source}'. Use out, out.a.b, out[0].b, out[].b (every item) or *.key (any depth).`, {
      code: "INVALID_IGNORE_PATH",
    });
  }
  const path: Seg[] = (m[2]!.match(/\.[A-Za-z0-9_$-]+|\[\d*\]/g) ?? []).map((s) =>
    s === "[]" ? "[]" : s.startsWith("[") ? Number(s.slice(1, -1)) : s.slice(1),
  );
  return { source, output: m[1]!, path };
}

function dropPath(value: unknown, path: Seg[]): unknown {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    if (head === "[]") return rest.length === 0 ? [] : value.map((v) => dropPath(v, rest));
    if (typeof head !== "number" || head >= value.length) return value;
    const copy = [...value];
    if (rest.length === 0) copy.splice(head, 1);
    else copy[head] = dropPath(copy[head], rest);
    return copy;
  }
  if (isObj(value) && typeof head === "string" && head !== "[]" && head in value) {
    const copy = { ...value };
    if (rest.length === 0) delete copy[head];
    else copy[head] = dropPath(copy[head], rest);
    return copy;
  }
  return value;
}

function dropKeyEverywhere(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((v) => dropKeyEverywhere(v, key));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key).map(([k, v]) => [k, dropKeyEverywhere(v, key)]));
  return value;
}

function sortLists(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortLists).sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sortLists(v)]));
  return value;
}

/** The outputs as compared: ignored paths dropped, lists sorted with --ignore-order. */
function normalizeOutputs(outputs: Record<string, unknown>, opts: CompareOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [code, value] of Object.entries(outputs)) {
    let v = value;
    for (const p of opts.ignore) {
      if (p.anyDepthKey) v = dropKeyEverywhere(v, p.anyDepthKey);
      else if (p.output === code) v = p.path.length === 0 ? undefined : dropPath(v, p.path);
    }
    if (v === undefined && opts.ignore.some((p) => p.output === code && p.path.length === 0)) continue;
    out[code] = opts.ignoreOrder ? sortLists(v) : v;
  }
  return out;
}

type Mismatch = "status" | "statusCode" | "failedStep" | "outputs";

export interface RunComparison {
  /** Same status, HTTP status, failing step and error, and outputs (as normalised). */
  identical: boolean;
  /** What differs. */
  mismatches: Mismatch[];
  /** Output-by-output differences (original values), when outputs were compared. */
  differences: OutputDifference[];
  /** false: both runs failed at the same step with the same error, so their partial outputs were not compared. */
  outputsCompared: boolean;
}

const failure = (r: TestRun) => (r.failedStep ? `${r.failedStep.index}\u0000${r.failedStep.parsedError.summary}` : "");

export function compareRuns(draft: TestRun, published: TestRun, opts: CompareOptions): RunComparison {
  const mismatches: Mismatch[] = [];
  if (draft.status !== published.status) mismatches.push("status");
  if (draft.statusCode !== published.statusCode) mismatches.push("statusCode");
  if (failure(draft) !== failure(published)) mismatches.push("failedStep");
  const outputsCompared = !(draft.status === "FAILED" && published.status === "FAILED" && failure(draft) === failure(published));
  let differences: OutputDifference[] = [];
  if (outputsCompared) {
    const names = new Set(diffOutputs(normalizeOutputs(draft.outputs, opts), normalizeOutputs(published.outputs, opts)).map((d) => d.output));
    differences = [...names].map((output) => ({ output, draft: draft.outputs[output], published: published.outputs[output] }));
    if (differences.length > 0) mismatches.push("outputs");
  }
  return { identical: mismatches.length === 0, mismatches, differences, outputsCompared };
}
