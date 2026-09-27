// belz pd validate <input> [--recursive] [--full] — run every validator rule
// over a page/component (and, with --recursive, every symbol it uses).
//
// PD-8 / F18: when any rule reports an ERROR the envelope is ok:false
// (PD_VALIDATION_FAILED, exit 1) with the full report in `data`. Rule
// severities are calibrated against real editor output (PD-5, Stage 7).
//
// Output (Stage 7, 7.9): errors are listed in full; warnings are grouped by
// code with one short ref per occurrence (variable name, callId, node id) —
// `--full` restores the flat per-issue list.

import { defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import { PD_FORCE_FLAG, PD_INPUT_POSITIONAL } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { cachedFetchPageConfig } from "../../lib/cache";
import { parsePage } from "../../lib/parser/index";
import { resolveInput } from "../../lib/resolver";
import { partitionBySeverity, validateHydrated } from "../../lib/validator/index";
import { validateRecursive, type SymbolFetcher } from "../../lib/validator/recursive";
import type { ValidationIssue } from "../../lib/types/common";

interface ValidateArgs {
  input: string;
  force: boolean;
  recursive: boolean;
  full: boolean;
}

/** Warnings of one code: how many, and a short ref per occurrence. */
export interface WarningGroup {
  count: number;
  refs: string[];
}

export interface EntityReport {
  name: string;
  id: string;
  entityType: "PAGE" | "COMPONENT";
  errorCount: number;
  warnCount: number;
  /** Errors always; warnings too with --full. */
  issues: ValidationIssue[];
  /** Warnings by code (omitted with --full). */
  warnings?: Record<string, WarningGroup>;
}

interface ValidateData extends EntityReport {
  recursive?: {
    entities: Array<EntityReport & { depth: number; uses: string[] }>;
    longestChain: string[];
    totalErrors: number;
    totalWarnings: number;
    fetchErrors: Array<{ name: string; message: string }>;
  };
}

export const args = defineArgs({
  command: "belz pd validate",
  positionals: [PD_INPUT_POSITIONAL],
  flags: {
    ...PD_FORCE_FLAG,
    recursive: { type: "boolean", alias: ["-r"] },
    full: { type: "boolean" },
  },
});

export function groupWarnings(issues: ValidationIssue[]): Record<string, WarningGroup> {
  const out: Record<string, WarningGroup> = {};
  for (const i of issues) {
    if (i.severity !== "warn") continue;
    const g = (out[i.code] ??= { count: 0, refs: [] });
    g.count++;
    // One-per-page codes (CSS_NOT_SCOPED, SYMBOL_NESTING_DEPTH…) keep their message.
    g.refs.push(i.path && i.path !== "styles" ? i.path : i.nodeId ?? i.message);
  }
  return out;
}

export function entityReport(
  head: { name: string; id: string; entityType: "PAGE" | "COMPONENT" },
  issues: ValidationIssue[],
  full: boolean,
): EntityReport {
  const { errors, warnings } = partitionBySeverity(issues);
  return {
    ...head,
    errorCount: errors.length,
    warnCount: warnings.length,
    issues: full ? issues : errors,
    ...(full ? {} : { warnings: groupWarnings(issues) }),
  };
}

const draftSymbolFetcher = (force: boolean): SymbolFetcher => ({
  async byName(name) {
    const id = await pdApi.fetchComponentIdByName(name);
    return id ? cachedFetchPageConfig(id, force) : null;
  },
});

const command: CommandModule<ValidateArgs, ValidateData> = {
  schema: "pd.validate",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { input: positionals.input, force: flags.force, recursive: flags.recursive, full: flags.full };
  },
  async execute({ input, force, recursive, full }, context) {
    const resolved = await resolveInput(input, force);
    const page = parsePage(resolved.response);
    const head = { name: page.name || resolved.resolvedId, id: resolved.resolvedId, entityType: resolved.entityType };

    let data: ValidateData;
    let totalErrors: number;
    if (recursive) {
      const rep = await validateRecursive(resolved.response, draftSymbolFetcher(force));
      for (const e of rep.fetchErrors) context.warn(`⚠ recursive: ${e.name}: ${e.message}`);
      const [root, ...rest] = rep.entries;
      data = {
        ...entityReport(head, root!.issues, full),
        recursive: {
          entities: rest.map((e) => ({
            ...entityReport({ name: e.name, id: e.id, entityType: e.entityType }, e.issues, full),
            depth: e.depth,
            uses: e.uses,
          })),
          longestChain: rep.longestChain,
          totalErrors: rep.errorCount,
          totalWarnings: rep.warnCount,
          fetchErrors: rep.fetchErrors,
        },
      };
      totalErrors = rep.errorCount;
    } else {
      data = entityReport(head, validateHydrated(page), full);
      totalErrors = data.errorCount;
    }

    if (totalErrors > 0) {
      const where = recursive ? `${data.name} and its symbols` : data.name;
      return failWithData("PD_VALIDATION_FAILED", `${totalErrors} validator error(s) on ${where}.`, data);
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const data = envelope.data as ValidateData | undefined;
    if (!data) return;

    const show = (e: EntityReport, title: string) => {
      ui.section(title);
      if (e.errorCount === 0 && e.warnCount === 0) {
        ui.success("No issues found.");
        return;
      }
      const errors = e.issues.filter((i) => i.severity === "error");
      if (errors.length) {
        ui.table(["#", "Code", "Message"], errors.map((i, idx) => [idx + 1, i.code, i.message]));
      }
      if (e.warnings) {
        const rows = Object.entries(e.warnings).map(([code, g]) => [
          code,
          g.count,
          g.refs.slice(0, 4).join(", ").slice(0, 100) + (g.refs.length > 4 ? ", …" : ""),
        ]);
        if (rows.length) ui.table(["Warning", "#", "Where"], rows);
      } else {
        const warns = e.issues.filter((i) => i.severity === "warn");
        if (warns.length) ui.table(["#", "Code", "Message"], warns.map((i, idx) => [idx + 1, i.code, i.message]));
      }
      ui.kv("Errors", e.errorCount);
      ui.kv("Warnings", e.warnCount);
    };

    show(data, `${data.name} (${data.entityType}, ${data.id})`);
    if (data.recursive) {
      for (const e of data.recursive.entities) {
        show(e, `${"  ".repeat(e.depth)}${e.name} (symbol, depth ${e.depth}, ${e.id})`);
      }
      ui.section("Summary");
      ui.kv("Entities", data.recursive.entities.length + 1);
      ui.kv("Longest symbol chain", data.recursive.longestChain.join(" → "));
      ui.kv("Errors (all)", data.recursive.totalErrors);
      ui.kv("Warnings (all)", data.recursive.totalWarnings);
    }
  },
};

export default command;
