import { type CommandModule, defineArgs, failWithData, ok } from "@belzabar/core";
import { requireConfirmation } from "../../lib/confirm";
import { resolveDataSource, type ResolvedDataSource } from "../../lib/datasource";
import { readSpecFile } from "../../lib/definition";
import { parseReportId, REPORT_ID_POSITIONAL } from "../../lib/report-id";
import { applySave, planSave } from "../../lib/write";

interface SaveArgs {
  id: string;
  spec: string;
  yes: boolean;
  dryRun: boolean;
}

interface SaveData {
  id: string;
  dryRun: boolean;
  /** False when the spec equals the saved definition (nothing written). */
  changed: boolean;
  changes: string[];
  dataSource: ResolvedDataSource;
  /** The report's previous definition, saved before the write (restore: rd save <id> --spec <backup>). */
  backup: string | null;
  /** Display settings the spec left out and the current report supplied (needs one run of it). */
  displayFromCurrent: boolean;
  mismatches: string[];
}

export const args = defineArgs({
  command: "wi-impl rd save",
  positionals: [REPORT_ID_POSITIONAL],
  flags: {
    spec: { type: "string", required: true, missingCode: "MISSING_SPEC", missingMessage: "Pass --spec <file> (edit the output of `wi-impl rd export`)." },
    yes: { type: "boolean", alias: ["-y"] },
    "dry-run": { type: "boolean" },
  },
});

const command: CommandModule<SaveArgs, SaveData> = {
  writes: (a) => !a.dryRun,
  requiresEnv: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { id: parseReportId(positionals.id), spec: flags.spec, yes: flags.yes, dryRun: flags.dryRun };
  },
  async execute({ id, spec: path, yes, dryRun }, context) {
    const wanted = await readSpecFile(path);
    const ds = await resolveDataSource(wanted.dataSource);
    const plan = await planSave(id, wanted, { dryRun });
    const { current, changes } = plan;
    const base = { id, dataSource: ds, displayFromCurrent: plan.displayFromCurrent, changes };

    if (changes.length === 0) {
      context.warn("The spec matches the saved definition; nothing to save.");
      return ok<SaveData>({ ...base, dryRun, changed: false, backup: null, mismatches: [] });
    }
    if (dryRun) return ok<SaveData>({ ...base, dryRun: true, changed: true, backup: null, mismatches: [] });

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `replace the definition of report ${id} ("${current.meta.title}") on ${context.env.name}`,
      details: [
        ["Report", `${current.meta.title} (${id})`],
        ["Datasource", `${ds.category} / ${ds.method} (chain ${ds.id})`],
        ["Changes", changes.join("\n")],
      ],
    });
    const { backup, mismatches } = await applySave(id, plan, ds);
    const data: SaveData = { ...base, dryRun: false, changed: true, backup, mismatches };
    if (mismatches.length > 0) {
      return failWithData("RD_VERIFY_FAILED", `Report ${id} was saved but reads back different: ${mismatches.join("; ")}.`, data);
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const d = envelope.data as SaveData | null;
    if (!d) return;
    if (!d.changed) return;
    ui.section(d.dryRun ? `Dry run: would change report ${d.id}` : `Saved report ${d.id}`);
    for (const c of d.changes) ui.text(`• ${c}`);
    if (d.dryRun && d.displayFromCurrent) ui.info("summaryPosition / filterConfig are not in the spec: the save keeps the report's current ones (it runs the report once to read them).");
    if (d.backup) ui.info(`Previous definition: ${d.backup}`);
    if (envelope.ok && !d.dryRun) ui.success("Read back and verified");
  },
};

export default command;
