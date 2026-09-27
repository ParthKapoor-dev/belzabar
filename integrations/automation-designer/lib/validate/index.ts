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
// Diff-aware: with `before` (the fetched draft), a finding whose fingerprint
// (rule + path, step indices replaced by the step id) is also found in
// `before` is downgraded to a warning with `preexisting: true`, so methods
// that already break a rule stay saveable and only NEW violations block.
// `strict` turns the remaining (new) warnings into errors; pre-existing
// findings stay warnings. `overlayPaths` (the JSON paths the caller meant to
// edit) marks new findings outside them as possible serializer drift.

import type { V2MethodBody } from "../types/v2-wire";
import { ruleInfo } from "./catalogue";
import { checkStructure } from "./schema";
import { checkSteps } from "./steps";
import { checkGraph } from "./graph";
import { isObj, arr, nonBlank, type FindingInput, type Report, type ValidationFinding, type ValidationResult } from "./types";

export type { ValidationFinding, ValidationResult, StepRef, Severity } from "./types";
export { RULES, ruleInfo, type RuleCode, type RuleInfo } from "./catalogue";

export interface ValidateInput {
  after: V2MethodBody;
  before?: V2MethodBody;
  overlayPaths?: string[];
  strict?: boolean;
}

export interface ValidateOnlineInput extends ValidateInput {
  env: string;
  dryRunCompile?: boolean;
}

export const OFFLINE_LAYERS = ["L1", "L2", "L3"] as const;

interface RawFinding extends ValidationFinding {
  fingerprint: string;
}

/** Run L1–L3 on one body and return every finding at its catalogue severity. */
export function collectOffline(body: unknown): RawFinding[] {
  const out: RawFinding[] = [];
  const stepKeys = stepKeyTable(body);
  const report: Report = (f: FindingInput) => out.push(toFinding(f, stepKeys));
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
  const stepKeys = stepKeyTable(input.after);
  for (const f of online.findings) findings.push(toFinding(f, stepKeys));
  layers.push(...online.layers);
  return finish(dedupe(findings), input, layers);
}

// ── internals ─────────────────────────────────────────────────────────────

function finish(findings: RawFinding[], input: ValidateInput, layersRun: string[]): ValidationResult {
  const before = input.before !== undefined ? new Set(collectOffline(input.before).map((f) => f.fingerprint)) : null;
  const overlay = input.overlayPaths?.filter((p) => p.length > 0) ?? [];
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  for (const raw of findings) {
    const { fingerprint, ...f } = raw;
    if (before?.has(fingerprint)) {
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

/** steps[i] → a stable key (the step id when present) for fingerprints. */
function stepKeyTable(body: unknown): string[] {
  if (!isObj(body)) return [];
  return arr(body.steps).map((s, i) => {
    const id = isObj(s) ? nonBlank(s.id) : undefined;
    return id ? `id:${id.toLowerCase()}` : `#${i}`;
  });
}

function toFinding(f: FindingInput, stepKeys: string[]): RawFinding {
  const info = ruleInfo(f.rule);
  const severity = f.severity ?? info?.severity ?? "error";
  const finding: RawFinding = {
    rule: f.rule,
    severity,
    message: f.message,
    path: f.path,
    fingerprint: `${f.rule}|${f.path.replace(/^steps\[(\d+)\]/, (_m, n: string) => `steps{${stepKeys[Number(n)] ?? `#${n}`}}`)}`,
  };
  if (f.step) finding.step = f.step;
  if (f.fix) finding.fix = f.fix;
  if (f.evidence) finding.evidence = f.evidence;
  return finding;
}

function dedupe(findings: RawFinding[]): RawFinding[] {
  const seen = new Set<string>();
  const out: RawFinding[] = [];
  for (const f of findings) {
    const k = `${f.fingerprint}|${f.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}
