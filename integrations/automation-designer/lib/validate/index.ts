// AD pre-save validator (Stage 5, requirement A4) — public API.
//
//   validateMethodV2({after, before?, overlayPaths?, strict?})       L1–L3, offline, pure
//   validateOnline({…, env, dryRunCompile?})                         L1–L4 (service lookup, optional dry-run compile)
//
// Input is the V2 wire body (`GET /chain/v2/{uuid}` shape) — exactly what the
// V2 save route POSTs. Layers (research/ad-validation.md §6.2):
//   L1 structure (schema.ts) · L2 per step (steps.ts) · L3 reference graph
//   (graph.ts) · L4 online (online.ts). Rule codes: catalogue.ts.
//
// Diff-aware: with `before` (the fetched draft, or the published copy on
// publish), a finding whose identity is also found in `before` is downgraded
// to a warning with `preexisting: true`, so methods that already break a rule
// stay saveable and only NEW violations block. The identity (ADW-R3/R4) is
// semantic, not positional: rule + path with each step index replaced by the
// ALIGNED `before` step (same step id, else an in-order match on the step's
// service/type — a draft and its published copy have different step ids) and
// every other array index by the element's `key`, plus the value at the path
// when it is a short scalar leaf, or the normalised finding message when it is
// a text leaf (SQL / code / template). So a different broken value, a
// different dangling ref in the same SQL, or a new output that lands on an old
// output's index, is NEW and blocks; an unrelated edit elsewhere in the same
// SQL / code body keeps its old findings pre-existing.
// `strict` turns the remaining (new) warnings into errors; pre-existing
// findings stay warnings. `overlayPaths` (the JSON paths the caller meant to
// edit) marks new findings outside them as possible serializer drift.

import type { V2MethodBody } from "../types/v2-wire";
import { ruleInfo } from "./catalogue";
import { checkStructure } from "./schema";
import { checkSteps } from "./steps";
import { checkGraph } from "./graph";
import { isBookkeepingKey } from "../fingerprint";
import { arr, str, type FindingInput, type Report, type ValidationFinding, type ValidationResult } from "./types";
import { isObj, str as nonBlank } from "@belzabar/core";

export type { ValidationFinding, ValidationResult, StepRef, Severity } from "./types";
export { RULES, ruleInfo } from "./catalogue";

interface ValidateInput {
  after: V2MethodBody;
  before?: V2MethodBody;
  overlayPaths?: string[];
  strict?: boolean;
}

interface ValidateOnlineInput extends ValidateInput {
  env: string;
  dryRunCompile?: boolean;
}

const OFFLINE_LAYERS = ["L1", "L2", "L3"] as const;

/** A finding plus the raw path it was reported at (identity is computed in `finish`). */
type RawFinding = ValidationFinding;

/** Run L1–L3 on one body and return every finding at its catalogue severity. */
function collectOffline(body: unknown): RawFinding[] {
  const out: RawFinding[] = [];
  const report: Report = (f: FindingInput) => out.push(toFinding(f));
  const usable = checkStructure(body, report);
  if (usable && isObj(body)) {
    checkSteps(body, report);
    checkGraph(body, report);
  }
  return dedupe(out);
}

export function validateMethodV2(input: ValidateInput): ValidationResult {
  const findings = collectOffline(input.after);
  return finish(findings, input, [...OFFLINE_LAYERS]);
}

export async function validateOnline(input: ValidateOnlineInput): Promise<ValidationResult> {
  const findings = collectOffline(input.after);
  const layers: string[] = [...OFFLINE_LAYERS];
  const { runOnline } = await import("./online");
  const online = await runOnline(input.after, { env: input.env, dryRunCompile: !!input.dryRunCompile });
  for (const f of online.findings) findings.push(toFinding(f));
  layers.push(...online.layers);
  // L4 findings already true of `before` are pre-existing too (service layer only: cached lookups, no second compile).
  const beforeExtra: RawFinding[] = [];
  if (input.before !== undefined) {
    const prior = await runOnline(input.before, { env: input.env, dryRunCompile: false });
    for (const f of prior.findings) beforeExtra.push(toFinding(f));
  }
  return finish(dedupe(findings), input, layers, beforeExtra);
}

/**
 * Findings for AUDITING an existing record (`ad validate <uuid>`, the real-body
 * calibration) rather than a body about to be saved: AD-META-001 on a
 * PUBLISHED record and M1 on its existing name describe how the record was
 * stored, not its logic, so they become notes/warnings (ADW-R15). The server
 * refuses such names on create and rename (live 400 on V1 and V2), so M1
 * stays an error for new bodies and renames.
 */
export function auditExistingRecord(result: ValidationResult, body: unknown): { errors: ValidationFinding[]; warnings: ValidationFinding[]; notes: string[] } {
  const state = isObj(body) && isObj(body.metadata) ? str(body.metadata.state) : undefined;
  const notes: string[] = [];
  const errors: ValidationFinding[] = [];
  const warnings = [...result.warnings];
  for (const e of result.errors) {
    if (e.rule === "AD-META-001" && state === "PUBLISHED") continue;
    if (e.rule === "M1" && e.path === "name") {
      warnings.push({ ...e, severity: "warn", message: `${e.message} The record already has this name; the server refuses it on create and rename.` });
      continue;
    }
    errors.push(e);
  }
  if (state === "PUBLISHED" && result.errors.some((e) => e.rule === "AD-META-001")) {
    notes.push("PUBLISHED record: AD-META-001 (save bodies must be drafts) is not reported; validate the draft before saving.");
  }
  return { errors, warnings, notes };
}

// ── internals ─────────────────────────────────────────────────────────────

function finish(findings: RawFinding[], input: ValidateInput, layersRun: string[], beforeExtra: RawFinding[] = []): ValidationResult {
  let before: Set<string> | null = null;
  let afterAnchors: string[] = [];
  if (input.before !== undefined) {
    const beforeAnchors = arr(isObj(input.before) ? input.before.steps : undefined).map((_s, j) => `s${j}`);
    afterAnchors = alignSteps(input.before, input.after).map((j, i) => (j >= 0 ? `s${j}` : `new${i}`));
    before = new Set(
      [...collectOffline(input.before), ...beforeExtra].map((f) => findingIdentity(f, input.before, beforeAnchors)),
    );
  }
  const overlay = input.overlayPaths?.filter((p) => p.length > 0) ?? [];
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  for (const raw of findings) {
    const f = { ...raw };
    if (before?.has(findingIdentity(raw, input.after, afterAnchors))) {
      f.preexisting = true;
      f.severity = "warn";
    } else {
      if (input.strict) f.severity = "error";
      if (overlay.length > 0 && f.path && !overlay.some((p) => underPath(f.path, p))) {
        f.message += " (outside the edited paths: possible serializer drift)";
      }
    }
    (f.severity === "error" ? errors : warnings).push(f);
  }
  return { errors, warnings, layersRun };
}

function underPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`) || prefix.startsWith(`${path}.`) || prefix.startsWith(`${path}[`);
}

/** Parse `steps[2].inputs[0].value` into ["steps", 2, "inputs", 0, "value"]. */
function pathParts(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) parts.push(m[2] !== undefined ? Number(m[2]) : m[1]!);
  return parts;
}

/**
 * Semantic identity of a finding within `body`: rule, the path with the step
 * index replaced by its anchor and other array indices by the element's key,
 * and the leaf value at the path (ids excluded: they differ draft vs published).
 */
function findingIdentity(f: ValidationFinding, body: unknown, stepAnchors: string[]): string {
  const parts = pathParts(f.path);
  let node: unknown = body;
  let label = "";
  let last: string | number | undefined;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (typeof p === "number") {
      const list = arr(node);
      const el = list[p];
      if (i === 1 && parts[0] === "steps") {
        label += `{${stepAnchors[p] ?? `new${p}`}}`;
      } else {
        const key = isObj(el) ? nonBlank(el.key) ?? nonBlank(el.fieldCode) : undefined;
        if (key) {
          const nth = list.slice(0, p).filter((x) => isObj(x) && (nonBlank(x.key) ?? nonBlank(x.fieldCode)) === key).length;
          label += `{${key}${nth ? `#${nth}` : ""}}`;
        } else label += `[${p}]`;
      }
      node = el;
    } else {
      label += `.${p}`;
      node = isObj(node) ? node[p] : undefined;
    }
    last = p;
  }
  // A TEXT leaf (SQL, code, a SpEL template: long or multi-line) is identified
  // by the finding's subject — its normalised message, which names the
  // offending ref/token — not by the whole text, so an unrelated edit to the
  // same body (a comment, another clause) keeps an old finding pre-existing
  // (ADW-R3). A short scalar keeps its value: a different broken value at the
  // same place is new.
  const leaf =
    typeof last === "string" && isBookkeepingKey(last)
      ? ""
      : node === null || node === undefined
        ? "∅"
        : typeof node === "object"
          ? ""
          : isTextLeaf(node)
            ? `msg:${normaliseMessage(f.message)}`
            : String(node).trim();
  return `${f.rule}|${label}|${leaf}`;
}

function isTextLeaf(v: unknown): boolean {
  return typeof v === "string" && (v.length > 80 || v.includes("\n"));
}

/** A finding message without positional detail (step numbers, line/column) that an unrelated edit shifts. */
function normaliseMessage(m: string): string {
  return m
    .replace(/\b[Ss]teps? \d+\b/g, "step #")
    .replace(/\b(line|col(umn)?)\s*:?\s*\d+/gi, "$1 #")
    .replace(/\(\d+:\d+\)/g, "(#:#)")
    .replace(/\s+/g, " ")
    .trim();
}

/** Coarse step signature for aligning steps whose ids differ (draft vs published). */
function stepSignature(s: unknown): string {
  if (!isObj(s)) return "?";
  const props = isObj(s.properties) ? s.properties : {};
  const cc = isObj(props.customCode) ? props.customCode : {};
  return [str(props.type) ?? "", nonBlank(s.serviceName) ?? "", nonBlank(s.methodName) ?? "", str(cc.language) ?? ""].join("/");
}

/**
 * For each step of `after`, the index of the matching `before` step, or -1.
 * Steps with the same id pair first (a save: same draft). The rest pair by a
 * longest common subsequence over their service/type signature, which keeps
 * order and aligns a draft with its published copy (all ids differ).
 */
export function alignSteps(before: unknown, after: unknown): number[] {
  const b = arr(isObj(before) ? before.steps : undefined);
  const a = arr(isObj(after) ? after.steps : undefined);
  const idOf = (s: unknown) => (isObj(s) ? nonBlank(s.id)?.toLowerCase() : undefined);
  const result = a.map(() => -1);
  const usedBefore = new Set<number>();
  const byId = new Map<string, number>();
  b.forEach((s, j) => {
    const id = idOf(s);
    if (id && !byId.has(id)) byId.set(id, j);
  });
  a.forEach((s, i) => {
    const id = idOf(s);
    const j = id ? byId.get(id) : undefined;
    if (j !== undefined && !usedBefore.has(j)) {
      result[i] = j;
      usedBefore.add(j);
    }
  });
  const ra = a.map((_s, i) => i).filter((i) => result[i] === -1);
  const rb = b.map((_s, j) => j).filter((j) => !usedBefore.has(j));
  if (ra.length === 0 || rb.length === 0) return result;
  const sa = ra.map((i) => stepSignature(a[i]));
  const sb = rb.map((j) => stepSignature(b[j]));
  const dp: number[][] = Array.from({ length: sa.length + 1 }, () => new Array<number>(sb.length + 1).fill(0));
  for (let x = sa.length - 1; x >= 0; x--) {
    for (let y = sb.length - 1; y >= 0; y--) {
      dp[x]![y] = sa[x] === sb[y] ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!);
    }
  }
  for (let x = 0, y = 0; x < sa.length && y < sb.length; ) {
    if (sa[x] === sb[y]) {
      result[ra[x]!] = rb[y]!;
      x++;
      y++;
    } else if (dp[x + 1]![y]! >= dp[x]![y + 1]!) x++;
    else y++;
  }
  return result;
}

function toFinding(f: FindingInput): RawFinding {
  const info = ruleInfo(f.rule);
  const severity = f.severity ?? info?.severity ?? "error";
  const finding: RawFinding = { rule: f.rule, severity, message: f.message, path: f.path };
  if (f.step) finding.step = f.step;
  if (f.fix) finding.fix = f.fix;
  if (f.evidence) finding.evidence = f.evidence;
  return finding;
}

function dedupe(findings: RawFinding[]): RawFinding[] {
  const seen = new Set<string>();
  const out: RawFinding[] = [];
  for (const f of findings) {
    const k = `${f.rule}|${f.path}|${f.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}
