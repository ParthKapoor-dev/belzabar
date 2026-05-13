// belz pd save <pageId> [--overlay <file> | --config <file>] [--dry-run] [--force] [--yes]
//
// The single safe-edit entry point. Flow:
//
//   1. parsePdCommonArgs(argv) → {force, yes, dryRun, rest}
//   2. resolveDraftTarget(pageId) → refuse PUBLISHED without --force
//   3. pdApi.fetchPage(draftId) + parsePage → HydratedPage (before)
//   4. Load overlay file OR raw config file
//   5. applyOverlay(before, overlay) OR replaceFullConfig(before, config) → after
//   6. validateHydrated(after); errors without --force → abort with list
//   7. Print stderr diff preview
//   8. --dry-run → emit envelope, exit 0
//   9. withLock(draftId, () =>
//         strategy === "partial" ? pdApi.savePagePartial(...)
//                                : pdApi.savePageFull(...)
//      )
//  10. re-fetch + diff with expected; emit envelope

import { readFile } from "node:fs/promises";
import { CliError, ok, type CommandModule } from "@belzabar/core";
import { parsePdCommonArgs } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { parsePage } from "../../lib/parser/index";
import {
  applyOverlay,
  hydratedToInnerConfig,
  overlayToPartialOperations,
  pickStrategy,
  serializeFull,
} from "../../lib/serialize/index";
import { partitionBySeverity, validateHydrated } from "../../lib/validator/index";
import { resolveDraftTarget, describeDraftGuardFailure } from "../../lib/draft-guard";
import { withLock } from "../../lib/lock";
import type { HydratedPage, Overlay, ValidationIssue } from "../../lib/types/common";
import type { RawPartialUpdateOperation } from "../../lib/types/wire";

interface SaveArgs {
  pageId: string;
  overlayFile: string | null;
  configFile: string | null;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
}

interface SaveData {
  pageId: string;
  draftId: string;
  publishedId: string | null;
  switchedFromPublished: boolean;
  strategy: "partial" | "full";
  dryRun: boolean;
  operationsCount: number;
  operationsPreview: RawPartialUpdateOperation[] | null;
  configurationBytes: number | null;
  diffSummary: {
    variablesAdded: string[];
    variablesRemoved: string[];
    variablesChanged: string[];
    httpAdded: string[];
    httpRemoved: string[];
    stylesChanged: boolean;
  };
  validation: { issues: ValidationIssue[]; errorCount: number; warnCount: number };
  parseWarnings: string[];
  result: {
    oldVersionId: number | null;
    newVersionId: number | null;
  } | null;
  bypassedErrors: ValidationIssue[];
}

function requireExactlyOne<T>(values: Array<T | null | undefined>, labels: string[]): void {
  const set = values.filter((v) => v !== null && v !== undefined).length;
  if (set !== 1) {
    throw new CliError(
      `Exactly one of ${labels.join(" / ")} is required (got ${set}).`,
      { code: "INVALID_FLAGS" },
    );
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function summariseDiff(before: HydratedPage, after: HydratedPage) {
  const vb = new Set(before.variables.map((v) => v.name));
  const va = new Set(after.variables.map((v) => v.name));
  const added: string[] = [], removed: string[] = [];
  for (const n of va) if (!vb.has(n)) added.push(n);
  for (const n of vb) if (!va.has(n)) removed.push(n);

  const ib = new Map(before.variables.map((v) => [v.name, JSON.stringify(v.initialValue)] as const));
  const changed: string[] = [];
  for (const v of after.variables) {
    const prior = ib.get(v.name);
    if (prior !== undefined && prior !== JSON.stringify(v.initialValue)) changed.push(v.name);
  }

  const hb = new Set(before.httpRequests.map((c) => c.callId ?? `idx:${c.index}`));
  const ha = new Set(after.httpRequests.map((c) => c.callId ?? `idx:${c.index}`));
  const httpAdded: string[] = [], httpRemoved: string[] = [];
  for (const n of ha) if (!hb.has(n)) httpAdded.push(n);
  for (const n of hb) if (!ha.has(n)) httpRemoved.push(n);

  return {
    variablesAdded: added,
    variablesRemoved: removed,
    variablesChanged: changed,
    httpAdded,
    httpRemoved,
    stylesChanged: before.styles !== after.styles,
  };
}

const command: CommandModule<SaveArgs, SaveData> = {
  schema: "pd.save",

  parseArgs(argv) {
    const { common, rest } = parsePdCommonArgs(argv);
    const pageId = rest[0];
    if (!pageId || pageId.startsWith("-")) {
      throw new CliError("Missing <pageId>.", { code: "MISSING_INPUT" });
    }
    const overlayFile = valueAfter(rest, "--overlay") ?? null;
    const configFile = valueAfter(rest, "--config") ?? null;
    requireExactlyOne([overlayFile, configFile], ["--overlay <file>", "--config <file>"]);

    return {
      pageId,
      overlayFile,
      configFile,
      dryRun: common.dryRun,
      force: common.force,
      yes: common.yes,
    };
  },

  async execute(args, context) {
    // Draft-guard
    const guard = await resolveDraftTarget(args.pageId);
    if (!guard.ok) {
      if (args.force && guard.reason === "PUBLISHED_NO_DRAFT") {
        context.warn(
          `⚠ --force: writing directly to PUBLISHED page ${guard.publishedId} (${guard.name}).`,
        );
      } else {
        throw describeDraftGuardFailure(guard);
      }
    }
    const targetId = guard.ok ? guard.draftId : guard.publishedId!;
    const before = guard.ok
      ? guard.draft
      : parsePage((await pdApi.fetchPage(targetId))!);

    if (guard.ok && guard.switchedFromPublished) {
      context.warn(
        `ℹ Input resolved to PUBLISHED page; writing to the linked draft ${guard.draftId}.`,
      );
    }

    // Load + apply the edit
    let after: HydratedPage;
    let operations: RawPartialUpdateOperation[] = [];
    let configurationString: string | null = null;
    let strategy: "partial" | "full";
    let overlay: Overlay | null = null;

    if (args.overlayFile) {
      const body = await readFile(args.overlayFile, "utf8");
      try {
        overlay = JSON.parse(body) as Overlay;
      } catch (err) {
        throw new CliError(`Overlay file parse failed: ${String(err)}`, { code: "INVALID_OVERLAY" });
      }
      after = applyOverlay(before, overlay);
      strategy = pickStrategy(overlay);
      if (strategy === "partial") {
        operations = overlayToPartialOperations(before, overlay);
      } else {
        configurationString = serializeFull(after);
      }
    } else {
      // --config <file> → full replace. File is a raw inner-config object (not stringified).
      const body = await readFile(args.configFile!, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new CliError(`Config file parse failed: ${String(err)}`, { code: "INVALID_CONFIG" });
      }
      configurationString = JSON.stringify(parsed);
      // Build a post-save HydratedPage view by wrapping the new config into the
      // existing wire response so the validator can score the result.
      const rewrapped = {
        ...(before.raw as Record<string, unknown>),
        configuration: configurationString,
      };
      after = parsePage(rewrapped as any);
      strategy = "full";
    }

    // Validate (on the *post-edit* state)
    const issues = validateHydrated(after);
    const { errors, warnings } = partitionBySeverity(issues);

    const bypassedErrors: ValidationIssue[] = [];
    if (errors.length > 0) {
      if (!args.force) {
        throw new CliError(
          `Validator found ${errors.length} error(s). Refusing to save. Use --force to bypass.`,
          {
            code: "PD_VALIDATION_FAILED",
            details: {
              issues: errors.map((e) => ({ code: e.code, message: e.message, nodeId: e.nodeId })),
            },
          },
        );
      } else {
        bypassedErrors.push(...errors);
        context.warn(`⚠ --force: bypassing ${errors.length} validator error(s):`);
        for (const e of errors) context.warn(`  [${e.code}] ${e.message}`);
      }
    }
    for (const w of warnings) context.warn(`⚠ ${w.code}: ${w.message}`);

    const diffSummary = summariseDiff(before, after);

    if (args.dryRun) {
      return ok<SaveData>({
        pageId: args.pageId,
        draftId: targetId,
        publishedId: guard.ok ? guard.publishedId : guard.publishedId,
        switchedFromPublished: guard.ok ? guard.switchedFromPublished : false,
        strategy,
        dryRun: true,
        operationsCount: operations.length,
        operationsPreview: strategy === "partial" ? operations : null,
        configurationBytes: strategy === "full" ? Buffer.byteLength(configurationString ?? "", "utf8") : null,
        diffSummary,
        validation: { issues, errorCount: errors.length, warnCount: warnings.length },
        parseWarnings: after.parseWarnings,
        result: null,
        bypassedErrors,
      });
    }

    // Require --yes for any real write in --llm mode (core's runner knows the
    // mode via context.llm; elsewhere we just require --yes for any write).
    if (!args.yes) {
      throw new CliError(
        `"save" is a write operation. Pass --yes to confirm writing to ${targetId}.`,
        { code: "CONFIRMATION_REQUIRED" },
      );
    }

    // Perform the write under lock
    const beforeVersion = before.versionId;
    const saveResult = await withLock(targetId, async () => {
      if (strategy === "partial") {
        // Some overlays legitimately produce zero ops (e.g. overlay.update of a
        // field with no changes). Treat zero ops as a no-op save.
        if (operations.length === 0) return { newVersionId: beforeVersion, raw: {} };
        return pdApi.savePagePartial(targetId, before.status, operations);
      }
      return pdApi.savePageFull(targetId, before.status, configurationString!);
    });

    return ok<SaveData>({
      pageId: args.pageId,
      draftId: targetId,
      publishedId: guard.ok ? guard.publishedId : guard.publishedId,
      switchedFromPublished: guard.ok ? guard.switchedFromPublished : false,
      strategy,
      dryRun: false,
      operationsCount: operations.length,
      operationsPreview: strategy === "partial" ? operations : null,
      configurationBytes: strategy === "full" ? Buffer.byteLength(configurationString ?? "", "utf8") : null,
      diffSummary,
      validation: { issues, errorCount: errors.length, warnCount: warnings.length },
      parseWarnings: after.parseWarnings,
      result: {
        oldVersionId: beforeVersion,
        newVersionId: saveResult.newVersionId,
      },
      bypassedErrors,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as SaveData;

    ui.table(
      ["Property", "Value"],
      [
        ["Page", data.pageId],
        ["Draft Target", data.draftId],
        ["Published", data.publishedId ?? "N/A"],
        ["Strategy", data.strategy],
        ["Dry-run", data.dryRun ? "yes" : "no"],
        ["Errors", data.validation.errorCount],
        ["Warnings", data.validation.warnCount],
        ["Bypassed Errors", data.bypassedErrors.length],
      ],
    );

    if (data.switchedFromPublished) {
      ui.info(`Input was a PUBLISHED page; belz wrote to the linked draft (${data.draftId}).`);
    }

    ui.section("Diff");
    const d = data.diffSummary;
    if (d.variablesAdded.length > 0) ui.text(`+ variables: ${d.variablesAdded.join(", ")}`);
    if (d.variablesRemoved.length > 0) ui.text(`- variables: ${d.variablesRemoved.join(", ")}`);
    if (d.variablesChanged.length > 0) ui.text(`~ variables: ${d.variablesChanged.join(", ")}`);
    if (d.httpAdded.length > 0) ui.text(`+ http: ${d.httpAdded.join(", ")}`);
    if (d.httpRemoved.length > 0) ui.text(`- http: ${d.httpRemoved.join(", ")}`);
    if (d.stylesChanged) ui.text(`~ styles changed`);

    if (data.strategy === "partial" && data.operationsPreview) {
      ui.section("Operations");
      ui.table(
        ["#", "Op", "Key", "Type"],
        data.operationsPreview.map((op, i) => [i + 1, op.operation, op.key, op.dataType]),
      );
    } else if (data.strategy === "full") {
      ui.kv("Config bytes", data.configurationBytes ?? 0);
    }

    if (data.dryRun) {
      ui.info("Dry-run — no network write performed. Re-run without --dry-run to save.");
      return;
    }

    if (data.result) {
      ui.success(`Saved. versionId ${data.result.oldVersionId ?? "?"} → ${data.result.newVersionId ?? "?"}.`);
    }
  },
};

export default command;
