// Fixtures for the validator tests (lib/validate).
//
//   golden()          the baseline method: echo → custom code → SQL
//   caseBody(name)    golden + a live case's patch (tests/fixtures/validate/cases.json; each
//                     entry keeps the observed server/runtime result)
//   realV2()          the 36 real acme-dev V2 bodies (tests/fixtures/real-v2)

import { readdirSync, readFileSync } from "fs";
import type { V2MethodBody } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;

interface PatchOp {
  path: Array<string | number>;
  value?: unknown;
  delete?: boolean;
}

export interface LiveCase {
  desc: string;
  save: string[];
  observed: string;
  patch: PatchOp[];
}

const GOLDEN_TEXT = readFileSync(`${FIX}/validate/golden.v2.json`, "utf8");
export const CASES: Record<string, LiveCase> = JSON.parse(readFileSync(`${FIX}/validate/cases.json`, "utf8"));

export function golden(): V2MethodBody {
  return JSON.parse(GOLDEN_TEXT) as V2MethodBody;
}

export function applyPatch<T>(body: T, ops: PatchOp[]): T {
  for (const op of ops) {
    let cur = body as unknown as Record<string | number, unknown>;
    for (const k of op.path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
    const last = op.path[op.path.length - 1]!;
    if (op.delete) delete cur[last];
    else cur[last] = structuredClone(op.value);
  }
  return body;
}

export function caseBody(name: string): V2MethodBody {
  const c = CASES[name];
  if (!c) throw new Error(`unknown validator case ${name}`);
  return applyPatch(golden(), c.patch);
}

/** Mutate a fresh golden copy. `any`: test mutations reach into arbitrary (also malformed) wire paths. */
export function mutate(fn: (m: any) => void): V2MethodBody {
  const m = golden();
  fn(m);
  return m;
}

export function realV2(): Array<{ file: string; body: V2MethodBody }> {
  const dir = `${FIX}/real-v2`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".v2.json"))
    .sort()
    .map((file) => ({ file, body: JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as V2MethodBody }));
}
