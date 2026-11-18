// A method's persistent test suite as case files, plus the write helpers that
// verify every write by reading the suite back.
//
// Live facts (2026-09-29) this module is built around:
//   - `POST /chain/testcases/{chainUuid}` stores the body verbatim (creates the
//     suite on first use) — the only write that persists every field.
//   - `PUT /chain/testcases/{chainUuid}/{id}` replaces inputs + assertions but
//     silently KEEPS name, description and active (the response echoes the new
//     values anyway, even with the full server body sent back).
//   - DELETE is a soft delete and the name stays reserved: re-creating it gives
//     400 "TestCase name should be unique". So a description can never be
//     changed through the API, and a deleted case's name cannot be reused.
//   - `POST /chain/testcases/bulk/{chainUuid}` takes `inputs` as a
//     {fieldCode: string} map (string values only, no defaultValue); the
//     documented array-of-UI-bodies is rejected with 400. wi-impl creates cases
//     one by one instead.
//   - The suite GET omits `active:false` (and deleted) cases.

import { CliError, isObj, type Obj } from "@belzabar/core";
import { adApi } from "../api/index";
import { caseFromWire, caseToWire, diffCases, type CaseFile } from "./case-file";
import { assertionOutput, isStructured } from "./expect";
import type { HydratedMethod } from "../types/common";

interface ServerCase {
  id: string;
  file: CaseFile;
}

export interface SuiteSnapshot {
  chainUuid: string;
  testSuiteId: string | null;
  cases: ServerCase[];
}


export async function fetchSuite(chainUuid: string): Promise<SuiteSnapshot> {
  const body = await adApi.listTestCases(chainUuid);
  const suite: Obj = isObj(body) ? body : { testCases: Array.isArray(body) ? body : [] };
  const cases = (Array.isArray(suite.testCases) ? suite.testCases : [])
    .filter(isObj)
    .filter((c) => c.active !== false)
    .map((c) => ({ id: typeof c.id === "string" ? c.id : "", file: caseFromWire(c) }));
  return { chainUuid, testSuiteId: typeof suite.id === "string" ? suite.id : null, cases };
}

// ── contract check ────────────────────────────────────────────────────────

export interface ContractProblem {
  case: string;
  /**
   * `text-input-braces`: a TEXT/STRING input holds the text "{}" (stored in a
   * `{"value": "{}"}` wrapper). It runs as that two-character string, not as
   * "no value" (only the platform's raw, unwrapped `{}` means unset).
   */
  kind: "unknown-input" | "unknown-output" | "missing-required-input" | "text-input-braces";
  key: string;
}

const TEXT_TYPES = new Set(["TEXT", "STRING"]);

/** Inputs / assertion outputs that the method does not declare, and text inputs that hold "{}". */
export function checkCaseContract(c: CaseFile, method: Pick<HydratedMethod, "inputs" | "outputs">): ContractProblem[] {
  const inputs = new Map(method.inputs.filter((i) => !i.hideInput).map((i) => [i.code, i]));
  const outputs = new Set(method.outputs.map((o) => o.code));
  const out: ContractProblem[] = [];
  for (const k of Object.keys(c.inputs)) if (!inputs.has(k)) out.push({ case: c.name, kind: "unknown-input", key: k });
  for (const [k, f] of inputs) if (f.required && !(k in c.inputs)) out.push({ case: c.name, kind: "missing-required-input", key: k });
  for (const [k, f] of inputs) {
    if (TEXT_TYPES.has(String(f.type ?? "").toUpperCase()) && c.inputs[k] === "{}" && !c.inputExtras?.[k]?.raw) {
      out.push({ case: c.name, kind: "text-input-braces", key: k });
    }
  }
  for (const a of c.assertions) if (isStructured(a) && !outputs.has(assertionOutput(a))) out.push({ case: c.name, kind: "unknown-output", key: assertionOutput(a) });
  return out;
}

/** Problems that make a case wrong (a missing required input and a "{}" text are only reported). */
export function blockingProblems(problems: ContractProblem[]): ContractProblem[] {
  return problems.filter((p) => p.kind !== "missing-required-input" && p.kind !== "text-input-braces");
}

/** The warning for text inputs that hold "{}", or null when there are none. */
export function textBracesWarning(problems: ContractProblem[]): string | null {
  const hits = problems.filter((p) => p.kind === "text-input-braces");
  if (hits.length === 0) return null;
  return (
    `${hits.map((p) => `${p.case}: '${p.key}'`).join(", ")} hold${hits.length === 1 ? "s" : ""} the text "{}": a TEXT/STRING input ` +
    'runs it as that two-character string, not as "no value". Remove the input from the case to leave it unset.'
  );
}

export function contractError(problems: ContractProblem[], methodName: string, hint = ""): CliError {
  const text = problems.map((p) => `${p.case}: ${p.kind} '${p.key}'`).join("; ");
  return new CliError(`Test case does not match ${methodName}'s contract: ${text}.${hint}`, {
    code: "AD_TESTCASE_CONTRACT",
    details: { problems },
  });
}

/**
 * `sync --drop-unknown-inputs`: leave out the inputs the method no longer
 * declares (in memory; the files are not changed). Returns what was dropped.
 */
export function dropUnknownInputs(files: CaseFile[], method: Pick<HydratedMethod, "inputs">): Array<{ case: string; key: string }> {
  const known = new Set(method.inputs.filter((i) => !i.hideInput).map((i) => i.code));
  const dropped: Array<{ case: string; key: string }> = [];
  for (const f of files) {
    for (const k of Object.keys(f.inputs)) {
      if (known.has(k)) continue;
      delete f.inputs[k];
      if (f.inputExtras) delete f.inputExtras[k];
      dropped.push({ case: f.name, key: k });
    }
    if (f.inputExtras && Object.keys(f.inputExtras).length === 0) delete f.inputExtras;
  }
  return dropped;
}

export { coerceInputValue } from "../input-collector";

// ── verified writes ───────────────────────────────────────────────────────

export interface CaseCheck {
  name: string;
  id: string | null;
  verified: boolean;
  /** Fields that did not read back as sent (or "missing": the case is not in the suite). */
  mismatched: string[];
}

/** Compare what was sent with what the suite now holds (by id, else by name). */
export function checkPersisted(sent: CaseFile, suite: SuiteSnapshot, id?: string | null, ignore: readonly string[] = []): CaseCheck {
  const hit = (id ? suite.cases.find((c) => c.id === id) : undefined) ?? suite.cases.find((c) => c.file.name === sent.name);
  if (!hit) return { name: sent.name, id: id ?? null, verified: false, mismatched: ["missing"] };
  const mismatched = diffCases(sent, hit.file).filter((f) => !ignore.includes(f));
  return { name: sent.name, id: hit.id, verified: mismatched.length === 0, mismatched };
}

export function verifyError(checks: CaseCheck[], extra: Obj = {}): CliError {
  const bad = checks.filter((c) => !c.verified);
  return new CliError(
    `Fetch-back verification failed for ${bad.length} test case(s): ${bad.map((c) => `${c.name} (${c.mismatched.join(", ")})`).join("; ")}.`,
    { code: "AD_TESTCASE_VERIFY_FAILED", details: { checks, ...extra } },
  );
}

function idOf(response: unknown): string | null {
  return isObj(response) && typeof response.id === "string" ? response.id : null;
}

export async function createCase(chainUuid: string, c: CaseFile): Promise<string | null> {
  try {
    return idOf(await adApi.createTestCase(chainUuid, caseToWire(c)));
  } catch (err) {
    if (err instanceof CliError && /should be unique/i.test(JSON.stringify(err.details ?? {}))) {
      throw new CliError(
        `Test case name '${c.name}' is taken — by a visible case, or by a deleted one (DELETE is a soft delete and names are never released). Rename the case.`,
        { code: "AD_TESTCASE_NAME_RESERVED", details: { name: c.name } },
      );
    }
    throw err;
  }
}

export async function updateCase(chainUuid: string, id: string, c: CaseFile): Promise<void> {
  await adApi.updateTestCase(chainUuid, id, caseToWire(c));
}

// ── sync plan ─────────────────────────────────────────────────────────────

type SyncAction = "create" | "update" | "delete" | "unchanged" | "drift" | "extra" | "conflict";

export interface SyncItem {
  action: SyncAction;
  name: string;
  id?: string;
  /** Fields that differ (update / drift). */
  changes?: string[];
  note?: string;
  /** Server error when --apply failed on this item. */
  error?: { code: string; message: string };
}

const DESCRIPTION_NOTE = "description differs; the server keeps a case's description (it cannot be changed through the API)";

/**
 * Plan a file → server sync, matching test cases by name:
 *   only in files → create; inputs/assertions differ → update (PUT);
 *   only the description differs → drift (reported, nothing to write: the
 *   API cannot change it); only on the server → delete with `prune`, else
 *   extra (left alone); the same name twice on the server → conflict.
 */
export function planSync(files: CaseFile[], suite: SuiteSnapshot, prune: boolean): SyncItem[] {
  const byName = new Map<string, ServerCase[]>();
  for (const c of suite.cases) byName.set(c.file.name, [...(byName.get(c.file.name) ?? []), c]);
  const items: SyncItem[] = [];
  const seen = new Set<string>();
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    seen.add(f.name);
    const server = byName.get(f.name) ?? [];
    if (server.length > 1) {
      items.push({ action: "conflict", name: f.name, note: `${server.length} server cases share this name (${server.map((s) => s.id).join(", ")})` });
      continue;
    }
    if (server.length === 0) {
      items.push({ action: "create", name: f.name });
      continue;
    }
    const id = server[0]!.id;
    const changes = diffCases(f, server[0]!.file);
    const writable = changes.filter((c) => c === "inputs" || c === "assertions");
    const item: SyncItem = { action: writable.length > 0 ? "update" : changes.length > 0 ? "drift" : "unchanged", name: f.name, id };
    if (changes.length > 0) item.changes = changes;
    if (changes.includes("description")) item.note = DESCRIPTION_NOTE;
    items.push(item);
  }
  for (const c of [...suite.cases].sort((a, b) => a.file.name.localeCompare(b.file.name))) {
    if (seen.has(c.file.name)) continue;
    items.push(
      prune
        ? { action: "delete", name: c.file.name, id: c.id, note: "soft delete: the name stays reserved" }
        : { action: "extra", name: c.file.name, id: c.id, note: "only on the server (use --prune to delete)" },
    );
  }
  return items;
}

export const WRITE_ACTIONS: readonly SyncAction[] = ["create", "update", "delete"];

/**
 * Apply a plan (creates/updates first, deletes last). A failing create or
 * update records its error and the other creates/updates still run, but then
 * no delete runs (each is marked AD_TESTCASE_SYNC_SKIPPED): deleting first-
 * class cases while their replacements failed would leave the suite short.
 * The usual failing create is a name a deleted case still holds, which the
 * suite GET cannot show in advance. Returns the case id written per name.
 */
export async function applySync(chainUuid: string, items: SyncItem[], files: CaseFile[]): Promise<Map<string, string | null>> {
  const byName = new Map(files.map((f) => [f.name, f]));
  const written = new Map<string, string | null>();
  const attempt = async (it: SyncItem, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      it.error = err instanceof CliError ? { code: err.code ?? "AD_API_ERROR", message: err.message } : { code: "AD_API_ERROR", message: String(err) };
    }
  };
  for (const it of items) {
    const f = byName.get(it.name);
    if (it.action === "create" && f) await attempt(it, async () => void written.set(it.name, await createCase(chainUuid, f)));
    if (it.action === "update" && f && it.id) {
      await attempt(it, async () => {
        await updateCase(chainUuid, it.id!, f);
        written.set(it.name, it.id!);
      });
    }
  }
  const failed = items.filter((it) => it.error).map((it) => `${it.action} ${it.name}`);
  for (const it of items) {
    if (it.action !== "delete" || !it.id) continue;
    if (failed.length > 0) {
      it.error = { code: "AD_TESTCASE_SYNC_SKIPPED", message: `not deleted, because ${failed.join(", ")} failed (the suite would be left short)` };
      continue;
    }
    await attempt(it, () => adApi.deleteTestCase(it.id!));
  }
  return written;
}
