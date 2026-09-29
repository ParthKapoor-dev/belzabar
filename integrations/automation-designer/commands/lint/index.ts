// belz ad lint <uuid|file> — read-only review of a method's V2 body (7.4):
// the pre-save validator (lib/validate L1–L3, + L4 with --online) plus the
// advisory review rules of lib/validate/lint.ts (SQL Q2–Q4, common AD
// anti-patterns, platform prose rules; descriptions with --docs).
// Output is grouped by step, one line per finding. Errors (validator) exit 1
// with AD_LINT_FAILED; lint rules only warn unless --strict.

import { defineArgs, failWithData, loadConfigFileRaw, ok, type CommandModule } from "@belzabar/core";
import { validateMethodV2, validateOnline, type ValidationFinding } from "../../lib/validate/index";
import { lintMethodV2 } from "../../lib/validate/lint";
import { loadTargetBody, methodTarget, type LoadedBody } from "../../lib/save/spec";

interface LintArgs {
  target: string;
  kind: "uuid" | "file";
  category: string | null;
  online: boolean;
  docs: boolean;
  strict: boolean;
}

export interface LintLine {
  severity: "error" | "warn";
  rule: string;
  message: string;
  path: string;
  fix?: string;
  preexisting?: boolean;
}

export interface LintGroup {
  /** "method" or "step 3 SQL db_service/data.read". */
  scope: string;
  orderIndex: number | null;
  findings: LintLine[];
}

export interface LintData {
  source: { kind: "uuid" | "file"; ref: string };
  /** The file was a compact create spec, expanded first (as `ad create --dry-run`). */
  spec?: LoadedBody<unknown>["spec"];
  uuid: string | null;
  name: string | null;
  state: string | null;
  clean: boolean;
  counts: { errors: number; warnings: number };
  /** Findings per rule code (quick triage). */
  byRule: Record<string, number>;
  groups: LintGroup[];
  layersRun: string[];
}

export const args = defineArgs({
  command: "belz ad lint",
  positionals: [{ name: "target", required: true, missingCode: "MISSING_TARGET", missingMessage: "Missing <uuid|file> argument." }],
  flags: {
    online: { type: "boolean", description: "Also check each step against its service contract on --env (L4)" },
    docs: { type: "boolean", description: "Also report missing descriptions" },
    strict: { type: "boolean", description: "Treat warnings as errors" },
    category: { type: "string", description: "Category for a compact spec file without spec.category" },
  },
});



/** Group findings by step (method-level first), one compact line each. */
export function groupFindings(findings: ValidationFinding[]): LintGroup[] {
  const groups = new Map<string, LintGroup>();
  for (const f of findings) {
    const idx = f.step?.orderIndex ?? stepIndexFromPath(f.path);
    const scope = idx === null ? "method" : `step ${idx}${f.step ? ` ${f.step.kind}${f.step.service ? ` ${f.step.service}` : ""}` : ""}`;
    const key = idx === null ? "method" : `step ${idx}`;
    const g = groups.get(key) ?? { scope, orderIndex: idx, findings: [] };
    if (f.step && g.scope === `step ${idx}`) g.scope = scope;
    const line: LintLine = { severity: f.severity, rule: f.rule, message: f.message, path: f.path };
    if (f.fix) line.fix = f.fix;
    if (f.preexisting) line.preexisting = true;
    g.findings.push(line);
    groups.set(key, g);
  }
  const order = (g: LintGroup) => (g.orderIndex === null ? -1 : g.orderIndex);
  const out = [...groups.values()].sort((a, b) => order(a) - order(b));
  for (const g of out) g.findings.sort((a, b) => (a.severity === b.severity ? a.rule.localeCompare(b.rule) : a.severity === "error" ? -1 : 1));
  return out;
}

function stepIndexFromPath(path: string): number | null {
  const m = /^steps\[(\d+)\]/.exec(path);
  return m ? Number(m[1]) + 1 : null;
}

const command: CommandModule<LintArgs, LintData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      ...methodTarget(positionals.target),
      category: flags.category ?? null,
      online: flags.online,
      docs: flags.docs,
      strict: flags.strict,
    };
  },
  async execute(a, context) {
    const loaded = await loadTargetBody(a, a.category);
    const body = loaded.body;
    const state = typeof body.metadata?.state === "string" ? body.metadata.state : null;
    const result = a.online ? await validateOnline({ after: body, env: context.env.name }) : validateMethodV2({ after: body });
    // Auditing a published record: "a save body must be a draft" is not a finding about the logic.
    const validator = [...result.errors, ...result.warnings].filter((f) => !(state === "PUBLISHED" && f.rule === "AD-META-001"));
    const resolverTables = loadConfigFileRaw().lint?.resolverTables;
    const lint = lintMethodV2(body, { docs: a.docs, ...(resolverTables ? { resolverTables } : {}) });
    const all = [...validator, ...lint].map((f) => (a.strict && f.severity === "warn" ? { ...f, severity: "error" as const } : f));

    const byRule: Record<string, number> = {};
    for (const f of all) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    const errors = all.filter((f) => f.severity === "error").length;
    const data: LintData = {
      source: { kind: a.kind, ref: a.target },
      ...(loaded.spec ? { spec: loaded.spec } : {}),
      uuid: typeof body.uuid === "string" ? body.uuid.trim() : null,
      name: typeof body.name === "string" ? body.name : null,
      state,
      clean: all.length === 0,
      counts: { errors, warnings: all.length - errors },
      byRule,
      groups: groupFindings(all),
      layersRun: [...result.layersRun, "lint"],
    };
    if (errors > 0) {
      return failWithData("AD_LINT_FAILED", `${errors} error(s), ${data.counts.warnings} warning(s) in ${data.name ?? a.target}.`, data);
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const d = envelope.data as LintData | null;
    if (!d) return;
    ui.section(`Lint ${d.name ?? d.source.ref}${d.state ? ` (${d.state})` : ""}`);
    for (const g of d.groups) {
      ui.text(g.scope);
      for (const f of g.findings) {
        const tag = f.severity === "error" ? "E" : "W";
        ui.text(`  ${tag} ${f.rule}${f.preexisting ? " (pre-existing)" : ""}  ${f.message}${f.fix ? `\n      fix: ${f.fix}` : ""}`);
      }
    }
    const summary = `${d.counts.errors} error(s), ${d.counts.warnings} warning(s) — ${d.layersRun.join(", ")}`;
    if (d.counts.errors === 0) ui.success(summary);
    else ui.error(summary);
  },
};

export default command;
