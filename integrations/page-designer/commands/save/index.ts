// belz pd save <pageId> (--overlay <file> | --config <file>)
//              [--dry-run] [--force-validation] [--allow-published] [--yes]
//
// The single safe-edit entry point. Flow:
//
//   1. read the edit file (overlay or raw inner config)
//   2. resolveWriteTarget: draft-guard via referenceId; a PUBLISHED page with
//      no draft needs --allow-published
//   3. plan + validate on the guard's snapshot (fail fast, before --yes):
//      applyOverlay → validateEdit (diff-aware: only what the edit introduces
//      can block) → planSave (partial ops that provably cover the overlay,
//      else full)
//   4. --dry-run → envelope, no lock, no write
//   5. --yes required
//   6. withLock(draft): FRESH fetch → re-plan + re-validate on it (PD-4;
//      versionId drift is reported) → PUT partial/full
//   7. verify: re-fetch and compare the stored config with the planned one;
//      a mismatch is ok:false PD_SAVE_VERIFY_FAILED (a lagging read is only a warning)

import { isDeepStrictEqual } from "node:util";
import { CliError, defineArgs, failWithData, ok, type CommandModule } from "@belzabar/core";
import {
  DEPRECATED_FORCE_WARNING,
  PD_DRY_RUN_FLAG,
  PD_WRITE_OVERRIDE_FLAGS,
  PD_YES_FLAG,
  writeOverrides,
  type WriteOverrides,
} from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { fetchFresh, gateValidation, logIntent, readJsonFile, requireConfirmation, resolveWriteTarget, versionDrift } from "../../lib/edit";
import { withLock } from "../../lib/lock";
import { editSummary, editSummaryLines, type EditSummary } from "../../lib/page-diff";
import { parsePage } from "../../lib/parser/index";
import { planSave, withConfiguration, type SavePlan } from "../../lib/serialize/index";
import { validateEdit } from "../../lib/validator/index";
import type { HydratedPage, Overlay, RawPartialUpdateOperation, ValidationIssue } from "../../lib/types/common";

interface SaveArgs {
  pageId: string;
  overlayFile: string | null;
  configFile: string | null;
  dryRun: boolean;
  overrides: WriteOverrides;
  yes: boolean;
}

interface SaveData {
  pageId: string;
  draftId: string;
  publishedId: string | null;
  switchedFromPublished: boolean;
  strategy: "partial" | "full";
  /** Why a full save was used (null for partial, or a raw --config replace). */
  fullSaveReason: string | null;
  dryRun: boolean;
  operationsCount: number;
  operationsPreview: RawPartialUpdateOperation[] | null;
  configurationBytes: number | null;
  diffSummary: EditSummary;
  validation: { issues: ValidationIssue[]; errorCount: number; warnCount: number };
  parseWarnings: string[];
  /** The page changed between the first read and the in-lock fetch (PD-4). */
  versionDrift: { from: number | null; to: number | null } | null;
  result: {
    oldVersionId: number | null;
    newVersionId: number | null;
  } | null;
  /** Post-save read-back: does the stored config equal the planned one? */
  verify: {
    status: "match" | "mismatch" | "stale-read" | "skipped";
    versionId: number | null;
    /** On mismatch: the config paths where the stored page differs from the plan (capped). */
    differingPaths?: string[];
  } | null;
  bypassedErrors: ValidationIssue[];
}

export const args = defineArgs({
  command: "belz pd save",
  positionals: [{ name: "page-id", required: true, missingCode: "MISSING_INPUT", missingMessage: "Missing <pageId>." }],
  flags: {
    overlay: { type: "string" },
    config: { type: "string" },
    ...PD_DRY_RUN_FLAG,
    ...PD_WRITE_OVERRIDE_FLAGS,
    ...PD_YES_FLAG,
  },
  // Exactly one of --overlay / --config.
  exclusive: [["overlay", "config"]],
  requireOneOf: [["overlay", "config"]],
  codes: { CONFLICTING_FLAGS: "INVALID_FLAGS", MISSING_FLAG: "INVALID_FLAGS" },
});

type Edit = { kind: "overlay"; overlay: Overlay } | { kind: "config"; config: unknown };

interface Prepared {
  after: HydratedPage;
  plan: SavePlan | { strategy: "full"; configurationString: string; patched: HydratedPage; fallbackReason: null };
  issues: ValidationIssue[];
}

function prepare(before: HydratedPage, edit: Edit): Prepared {
  if (edit.kind === "overlay") {
    const plan = planSave(before, edit.overlay);
    return { after: plan.patched, plan, issues: validateEdit(before, plan.patched) };
  }
  const after = withConfiguration(before, edit.config);
  return {
    after,
    plan: { strategy: "full", configurationString: JSON.stringify(edit.config), patched: after, fallbackReason: null },
    issues: validateEdit(before, after),
  };
}

async function verifySaved(
  targetId: string,
  expected: HydratedPage,
  newVersionId: number | null,
): Promise<NonNullable<SaveData["verify"]>> {
  const raw = await pdApi.fetchPage(targetId);
  if (!raw) return { status: "skipped", versionId: null };
  const stored = parsePage(raw);
  if (newVersionId !== null && stored.versionId !== newVersionId) {
    return { status: "stale-read", versionId: stored.versionId };
  }
  if (isDeepStrictEqual(stored.rawConfiguration, expected.rawConfiguration)) {
    return { status: "match", versionId: stored.versionId };
  }
  return { status: "mismatch", versionId: stored.versionId, differingPaths: differingPaths(expected.rawConfiguration, stored.rawConfiguration) };
}

const DIFF_PATH_CAP = 20;

/** Config paths where `a` and `b` differ (leaf-most, capped at DIFF_PATH_CAP). */
export function differingPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= DIFF_PATH_CAP || isDeepStrictEqual(a, b)) return out;
  const objA = !!a && typeof a === "object";
  const objB = !!b && typeof b === "object";
  if (!objA || !objB || Array.isArray(a) !== Array.isArray(b)) {
    out.push(path || "(root)");
    return out;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const sub = Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
    differingPaths(ra[k], rb[k], sub, out);
    if (out.length >= DIFF_PATH_CAP) break;
  }
  return out;
}

const command: CommandModule<SaveArgs, SaveData> = {
  schema: "pd.save",

  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      pageId: positionals.pageId,
      overlayFile: flags.overlay ?? null,
      configFile: flags.config ?? null,
      dryRun: flags.dryRun,
      overrides: writeOverrides(flags),
      yes: flags.yes,
    };
  },

  async execute(args, context) {
    const warn = (m: string) => context.warn(m);
    if (args.overrides.deprecatedForce) warn(`⚠ ${DEPRECATED_FORCE_WARNING}`);

    const edit: Edit = args.overlayFile
      ? { kind: "overlay", overlay: (await readJsonFile(args.overlayFile, "INVALID_OVERLAY", "Overlay")) as Overlay }
      : { kind: "config", config: await readJsonFile(args.configFile!, "INVALID_CONFIG", "Config") };
    if (edit.kind === "config" && (!edit.config || typeof edit.config !== "object" || Array.isArray(edit.config))) {
      throw new CliError("Config file must hold the inner configuration OBJECT.", { code: "INVALID_CONFIG" });
    }

    const target = await resolveWriteTarget(args.pageId, args.overrides, warn, "writing to");
    const { targetId } = target;

    // Plan + validate on the snapshot first: fail fast, before --yes.
    const first = prepare(target.snapshot, edit);
    const firstGate = gateValidation(first.issues, args.overrides.forceValidation, warn);

    const build = (
      before: HydratedPage,
      p: Prepared,
      gate: typeof firstGate,
      extra: Pick<SaveData, "dryRun" | "versionDrift" | "result" | "verify">,
    ): SaveData => ({
      pageId: args.pageId,
      draftId: targetId,
      publishedId: target.publishedId,
      switchedFromPublished: target.switchedFromPublished,
      strategy: p.plan.strategy,
      fullSaveReason: p.plan.strategy === "full" ? p.plan.fallbackReason : null,
      operationsCount: p.plan.strategy === "partial" ? p.plan.operations.length : 0,
      operationsPreview: p.plan.strategy === "partial" ? p.plan.operations : null,
      configurationBytes: p.plan.strategy === "full" ? Buffer.byteLength(p.plan.configurationString, "utf8") : null,
      diffSummary: editSummary(before, p.after),
      validation: { issues: p.issues, errorCount: gate.errors.length, warnCount: gate.warnings.length },
      parseWarnings: p.after.parseWarnings,
      bypassedErrors: gate.bypassedErrors,
      ...extra,
    });

    if (args.dryRun) {
      return ok(build(target.snapshot, first, firstGate, { dryRun: true, versionDrift: null, result: null, verify: null }));
    }

    await requireConfirmation(context, args.yes, "save", [
      ["Page", `${first.after.name} (${targetId})`],
      ["Strategy", first.plan.strategy],
      ["Changes", editSummaryLines(editSummary(target.snapshot, first.after)).join("; ") || "(none)"],
    ]);
    logIntent("save", targetId, { strategy: first.plan.strategy });

    return withLock(targetId, async () => {
      // PD-4: fetch, apply and validate INSIDE the lock, on the latest version.
      const fresh = await fetchFresh(targetId);
      const drift = versionDrift(target.snapshot, fresh, warn);
      const p = drift ? prepare(fresh, edit) : first;
      const gate = drift ? gateValidation(p.issues, args.overrides.forceValidation, warn, false) : firstGate;

      if (isDeepStrictEqual(fresh.rawConfiguration, p.after.rawConfiguration)) {
        warn("ℹ The edit changes nothing on the current page — no write performed.");
        return ok(build(fresh, p, gate, {
          dryRun: false,
          versionDrift: drift,
          result: { oldVersionId: fresh.versionId, newVersionId: fresh.versionId },
          verify: { status: "skipped", versionId: fresh.versionId },
        }));
      }

      const saved =
        p.plan.strategy === "partial"
          ? await pdApi.savePagePartial(targetId, fresh.status, p.plan.operations)
          : await pdApi.savePageFull(targetId, fresh.status, p.plan.configurationString);

      const verify = await verifySaved(targetId, p.after, saved.newVersionId);
      if (verify.status === "stale-read") {
        warn(`ℹ Read-back returned versionId ${verify.versionId ?? "?"} (saved ${saved.newVersionId}); the server read may lag.`);
      }

      const data = build(fresh, p, gate, {
        dryRun: false,
        versionDrift: drift,
        result: { oldVersionId: fresh.versionId, newVersionId: saved.newVersionId },
        verify,
      });
      if (verify.status === "mismatch") {
        // OTH-R3: the server stored something other than the plan (like AD_SAVE_VERIFY_FAILED).
        return failWithData(
          "PD_SAVE_VERIFY_FAILED",
          `Saved ${targetId} (versionId ${saved.newVersionId ?? "?"}), but the read-back does not match the planned config ` +
            `at ${verify.differingPaths?.length ?? 0} path(s). Inspect with \`belz pd show ${targetId} --force\`.`,
          data,
          { details: { pageId: targetId, strategy: p.plan.strategy, newVersionId: saved.newVersionId, differingPaths: verify.differingPaths ?? [] } },
        );
      }
      return ok(data);
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.data) return;
    const data = envelope.data as SaveData;

    ui.table(
      ["Property", "Value"],
      [
        ["Page", data.pageId],
        ["Draft Target", data.draftId],
        ["Published", data.publishedId ?? "N/A"],
        ["Strategy", data.fullSaveReason ? `full (${data.fullSaveReason})` : data.strategy],
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
    const lines = editSummaryLines(data.diffSummary);
    if (lines.length === 0) ui.text("(no changes)");
    for (const l of lines) ui.text(l);

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
    if (data.verify && data.verify.status !== "match") ui.kv("Read-back", data.verify.status);
    if (data.verify?.differingPaths?.length) ui.kv("Differs at", data.verify.differingPaths.join(", "));
  },
};

export default command;
