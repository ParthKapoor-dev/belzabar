// Test cases across a V2 body write (`ad save`, `ad history restore`).
//
// Live (2026-11-11, 2026-11-18): any V2 save makes the server rewrite the
// method's persisted test cases: every input a case did not set gets a raw
// `{}` (no `{"value": …}` wrapper), and inputs the method no longer has are
// dropped. A test-case PUT with the original inputs restores a case exactly.
//
// So the writer snapshots the cases (the V2 GET carries `testSuite`) before
// the write, compares them with the body read back after it, and PUTs every
// case the server changed back to its snapshot — keeping only the removal of
// inputs the method no longer declares. `--keep-case-changes` reports
// without restoring.

import { CliError, isObj } from "@belzabar/core";
import * as v2 from "../api/v2";
import { caseFromWire, diffCases, type CaseFile } from "../test-cases/case-file";
import { updateCase } from "../test-cases/suite";
import type { V2MethodResponse } from "../types/v2-wire";

export interface CaseGuardResult {
  /** Names of the cases the write changed on the server. */
  changedByServer: string[];
  /** Cases PUT back to their snapshot and verified on a re-read. */
  restored: string[];
  /** Cases that could not be restored, with why. */
  failed: Array<{ name: string; id: string; reason: string }>;
  /** true when `--keep-case-changes` left the server's changes in place. */
  kept?: true;
}

interface SnapCase {
  id: string;
  file: CaseFile;
}

/** The active test cases a V2 body carries, by id; null when the body has no suite field. */
function suiteCases(body: unknown): Map<string, SnapCase> | null {
  if (!isObj(body) || !("testSuite" in body)) return null;
  const suite = body.testSuite;
  const list = isObj(suite) && Array.isArray(suite.testCases) ? suite.testCases : [];
  const out = new Map<string, SnapCase>();
  for (const c of list) {
    if (!isObj(c) || c.active === false || typeof c.id !== "string") continue;
    out.set(c.id, { id: c.id, file: caseFromWire(c) });
  }
  return out;
}

interface CaseRestore {
  id: string;
  name: string;
  /** What the case should read: the snapshot minus inputs the method dropped; null = cannot restore. */
  restore: CaseFile | null;
  reason?: string;
}

/**
 * Pure: the cases `after` changed relative to `before`, each with the case
 * file to PUT back. An input the server removed stays removed when the
 * method (in `after`) no longer declares it; everything else — a `{}` the
 * server added, a value it rewrote — goes back to the snapshot.
 */
export function planCaseRestores(before: unknown, after: unknown): CaseRestore[] {
  const was = suiteCases(before);
  const now = suiteCases(after);
  if (!was || !now) return [];
  const declared = new Set(
    (isObj(after) && Array.isArray(after.inputs) ? after.inputs : []).filter(isObj).map((i) => String(i.key ?? i.fieldCode ?? "")),
  );
  const out: CaseRestore[] = [];
  for (const { id, file } of was.values()) {
    const cur = now.get(id);
    if (!cur) {
      out.push({ id, name: file.name, restore: null, reason: "the case is gone after the write" });
      continue;
    }
    const want = structuredClone(file);
    for (const k of Object.keys(want.inputs)) {
      if (k in cur.file.inputs || declared.has(k)) continue;
      delete want.inputs[k];
      if (want.inputExtras) delete want.inputExtras[k];
    }
    if (want.inputExtras && Object.keys(want.inputExtras).length === 0) delete want.inputExtras;
    if (diffCases(want, cur.file).length > 0) out.push({ id, name: file.name, restore: want });
  }
  return out;
}

/**
 * Compare the cases of `before` (read just before the write) and `after`
 * (read just after it) and, unless `keep`, PUT every changed case back and
 * verify it on one more V2 read. Never throws: a failed restore is reported.
 */
export async function guardTestCases(input: {
  chainUuid: string;
  before: V2MethodResponse;
  after: V2MethodResponse;
  keep: boolean;
  warn: (msg: string) => void;
}): Promise<CaseGuardResult> {
  const plan = planCaseRestores(input.before, input.after);
  const res: CaseGuardResult = { changedByServer: plan.map((p) => p.name), restored: [], failed: [] };
  if (plan.length === 0) return res;
  if (input.keep) {
    res.kept = true;
    input.warn(
      `The write changed ${plan.length} test case(s) on the server (${res.changedByServer.join(", ")}); kept (--keep-case-changes). ` +
        `Inspect with: wi-impl ad test-case list ${input.chainUuid}`,
    );
    return res;
  }
  const sent: Array<{ id: string; name: string; file: CaseFile }> = [];
  for (const p of plan) {
    if (!p.restore) {
      res.failed.push({ name: p.name, id: p.id, reason: p.reason ?? "cannot restore" });
      continue;
    }
    try {
      await updateCase(input.chainUuid, p.id, p.restore);
      sent.push({ id: p.id, name: p.name, file: p.restore });
    } catch (err) {
      res.failed.push({ name: p.name, id: p.id, reason: err instanceof CliError ? `${err.code}: ${err.message}` : String(err) });
    }
  }
  if (sent.length > 0) {
    let now: Map<string, SnapCase> | null = null;
    try {
      now = suiteCases(await v2.fetchRawMethod(input.chainUuid));
    } catch (err) {
      for (const s of sent) res.failed.push({ name: s.name, id: s.id, reason: `restored, but the re-read failed: ${String(err)}` });
    }
    if (now) {
      for (const s of sent) {
        const got = now.get(s.id);
        const diff = got ? diffCases(s.file, got.file) : ["missing"];
        if (diff.length === 0) res.restored.push(s.name);
        else res.failed.push({ name: s.name, id: s.id, reason: `restored, but reads back different (${diff.join(", ")})` });
      }
    }
  }
  if (res.failed.length > 0) {
    input.warn(
      `The write changed ${plan.length} test case(s) on the server (it fills unset inputs with {} and rewrites values); ` +
        `restored ${res.restored.length}; NOT restored: ${res.failed.map((f) => `${f.name} (${f.reason})`).join("; ")}. ` +
        `Fix with: wi-impl ad test-case update ${input.chainUuid} <testCaseId> --file <case.json>`,
    );
  }
  return res;
}
