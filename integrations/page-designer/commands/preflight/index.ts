// belz pd preflight <pageId> [--overlay <file>]
//
// Read-only dry-run. Resolves the page `save` would write (the same
// draft guard — a PUBLISHED id with a linked draft checks that draft),
// optionally applies an overlay, runs the validator (diff-aware with an
// overlay — the same gate `save` uses), and reports what would change and how
// it would be saved. Never writes.
//
// When the validator reports errors the envelope is ok:false
// (PD_PREFLIGHT_FAILED, exit 1) with the full result in `data`, so agent
// scripts can chain: `belz pd preflight … && belz pd save …`.

import { CliError, defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import { readJsonFile, resolveWriteTarget, type WriteTarget } from "../../lib/edit";
import { countNodes, editSummary, editSummaryLines, type EditSummary } from "../../lib/page-diff";
import { assertOverlayShape } from "../../lib/serialize/overlay-shape";
import { planSave } from "../../lib/serialize/index";
import { partitionBySeverity, validateEdit, validateHydrated } from "../../lib/validator/index";
import type { HydratedPage, Overlay, ValidationIssue } from "../../lib/types/common";

interface PreflightArgs {
  pageId: string;
  overlayFile: string | null;
}

interface PreflightData {
  pageId: string;
  /** The page save would write (the linked draft for a PUBLISHED input). */
  targetId: string;
  switchedFromPublished: boolean;
  name: string;
  entityType: "PAGE" | "COMPONENT";
  status: string;
  hasOverlay: boolean;
  overlayStrategy: "partial" | "full" | null;
  /** Why the overlay would be a full save (null for partial / no overlay). */
  fullSaveReason: string | null;
  operationsCount: number | null;
  beforeStats: { variables: number; derived: number; httpRequests: number; nodes: number };
  afterStats: { variables: number; derived: number; httpRequests: number; nodes: number };
  diffSummary: EditSummary;
  validation: {
    issues: ValidationIssue[];
    errorCount: number;
    warnCount: number;
  };
  parseWarnings: string[];
}

export const args = defineArgs({
  command: "belz pd preflight",
  positionals: [{ name: "page-id", required: true, missingCode: "MISSING_INPUT", missingMessage: "Missing <pageId>." }],
  flags: {
    overlay: { type: "string" },
  },
});

function stats(page: HydratedPage) {
  return {
    variables: page.variables.length,
    derived: page.derived.length,
    httpRequests: page.httpRequests.length,
    nodes: countNodes(page),
  };
}

const command: CommandModule<PreflightArgs, PreflightData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { pageId: positionals.pageId, overlayFile: flags.overlay ?? null };
  },

  async execute({ pageId, overlayFile }, context) {
    const warn = (m: string) => context.warn(m);
    const overlay = overlayFile ? assertOverlayShape(await readJsonFile(overlayFile, "INVALID_OVERLAY", "Overlay")) : null;
    const noOverrides = { forceValidation: false, allowPublished: false };
    let target: WriteTarget;
    try {
      target = await resolveWriteTarget(pageId, noOverrides, warn, "checking");
    } catch (err) {
      if (!(err instanceof CliError) || err.code !== "PD_PUBLISHED_NO_DRAFT") throw err;
      // Read-only: check the PUBLISHED page itself, but say save would need the override.
      target = await resolveWriteTarget(pageId, { ...noOverrides, allowPublished: true }, () => {}, "checking");
      warn(`ℹ ${pageId} is a PUBLISHED page with no linked draft; \`belz pd save\` would need --allow-published.`);
    }
    const before = target.snapshot;

    let after: HydratedPage = before;
    let issues: ValidationIssue[];
    let overlayStrategy: PreflightData["overlayStrategy"] = null;
    let fullSaveReason: string | null = null;
    let operationsCount: number | null = null;
    if (overlay) {
      const plan = planSave(before, overlay);
      after = plan.patched;
      overlayStrategy = plan.strategy;
      fullSaveReason = plan.strategy === "full" ? plan.fallbackReason : null;
      operationsCount = plan.strategy === "partial" ? plan.operations.length : null;
      issues = validateEdit(before, after);
    } else {
      issues = validateHydrated(before);
    }
    const { errors, warnings } = partitionBySeverity(issues);

    const data: PreflightData = {
      pageId,
      targetId: target.targetId,
      switchedFromPublished: target.switchedFromPublished,
      name: after.name,
      entityType: after.entityType,
      status: after.status,
      hasOverlay: !!overlay,
      overlayStrategy,
      fullSaveReason,
      operationsCount,
      beforeStats: stats(before),
      afterStats: stats(after),
      diffSummary: editSummary(before, after),
      validation: { issues, errorCount: errors.length, warnCount: warnings.length },
      parseWarnings: after.parseWarnings,
    };
    if (errors.length > 0) {
      return failWithData(
        "PD_PREFLIGHT_FAILED",
        `Preflight found ${errors.length} validator error(s) — save would be blocked unless --force-validation.`,
        data,
      );
    }
    return ok(data);
  },

  presentHuman(envelope, ui) {
    const data = envelope.data as PreflightData | undefined;
    if (!data) return;

    ui.table(
      ["Property", "Value"],
      [
        ["Page", data.pageId],
        ...(data.targetId !== data.pageId ? [["Checked (draft)", data.targetId] as [string, string]] : []),
        ["Name", data.name],
        ["Entity Type", data.entityType],
        ["Status", data.status],
        ["Overlay", data.hasOverlay ? `yes (${data.fullSaveReason ? `full: ${data.fullSaveReason}` : data.overlayStrategy})` : "none"],
        ["Errors", data.validation.errorCount],
        ["Warnings", data.validation.warnCount],
      ],
    );

    if (data.hasOverlay) {
      ui.section("Diff");
      const lines = editSummaryLines(data.diffSummary);
      if (lines.length === 0) ui.text("(no differences)");
      for (const l of lines) ui.text(l);
    }

    if (data.validation.issues.length > 0) {
      ui.section("Validator Issues");
      ui.table(
        ["Sev", "Code", "Message"],
        data.validation.issues.map((i) => [
          `${i.severity.toUpperCase()}${i.preExisting ? " (pre-existing)" : ""}`,
          i.code,
          i.message,
        ]),
      );
    }

    if (data.parseWarnings.length > 0) {
      ui.section("Parse Warnings");
      for (const w of data.parseWarnings) ui.text(`⚠ ${w}`);
    }

    if (data.validation.errorCount === 0) ui.success("Preflight clean — save would be accepted.");
  },
};

export default command;
