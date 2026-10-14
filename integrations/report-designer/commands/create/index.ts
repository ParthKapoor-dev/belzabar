import { type CommandModule, defineArgs, failWithData, ok, str } from "@belzabar/core";
import { listReports } from "../../lib/api";
import { requireConfirmation } from "../../lib/confirm";
import { resolveDataSource, type ResolvedDataSource } from "../../lib/datasource";
import { readSpecFile } from "../../lib/definition";
import { createReport } from "../../lib/write";

interface CreateArgs {
  spec: string;
  yes: boolean;
  dryRun: boolean;
}

interface CreateData {
  dryRun: boolean;
  /** The new report's id (null on --dry-run). */
  id: string | null;
  title: string;
  dataSource: ResolvedDataSource;
  columns: number;
  filters: number;
  /** Ids of existing reports with the same title on this env. */
  sameTitle: string[];
  /** Read-back differences (empty = verified). */
  mismatches: string[];
}

export const args = defineArgs({
  command: "wi-impl rd create",
  flags: {
    spec: { type: "string", required: true, missingCode: "MISSING_SPEC", missingMessage: "Pass --spec <file> (a spec written by `wi-impl rd export`, or your own)." },
    yes: { type: "boolean", alias: ["-y"] },
    "dry-run": { type: "boolean" },
  },
});

const command: CommandModule<CreateArgs, CreateData> = {
  writes: (a) => !a.dryRun,
  // --dry-run resolves the datasource on the target env.
  requiresEnv: true,
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    return { spec: flags.spec, yes: flags.yes, dryRun: flags.dryRun };
  },
  async execute({ spec: path, yes, dryRun }, context) {
    const spec = await readSpecFile(path);
    const ds = await resolveDataSource(spec.dataSource);
    const sameTitle = (await listReports({ search: spec.title, sort: "created", limit: 100 }))
      .filter((r) => str(r.title) === spec.title)
      .map((r) => str(r.id)?.trim() ?? "");
    if (sameTitle.length > 0) context.warn(`${sameTitle.length} report(s) named "${spec.title}" already exist on ${context.env.name}: ${sameTitle.join(", ")}.`);
    const base = { title: spec.title, dataSource: ds, columns: spec.columns.length, filters: spec.filters.length, sameTitle };
    if (dryRun) return ok<CreateData>({ dryRun: true, id: null, ...base, mismatches: [] });

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `create report "${spec.title}" on ${context.env.name}`,
      details: [
        ["Title", spec.title],
        ["Datasource", `${ds.category} / ${ds.method} (chain ${ds.id})`],
        ["Columns", String(spec.columns.length)],
        ["Saved filters", String(spec.filters.length)],
      ],
    });
    const result = await createReport(spec, ds);
    const data: CreateData = { dryRun: false, id: result.id, ...base, mismatches: result.mismatches };
    if (result.mismatches.length > 0) {
      return failWithData("RD_VERIFY_FAILED", `Report ${result.id} was created but reads back different: ${result.mismatches.join("; ")}.`, data);
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    const d = envelope.data as CreateData | null;
    if (!d) return;
    if (d.dryRun) ui.info(`Dry run: would create "${d.title}" on ${d.dataSource.category} / ${d.dataSource.method} (chain ${d.dataSource.id}), ${d.columns} column(s), ${d.filters} filter(s).`);
    else if (envelope.ok) ui.success(`Created report ${d.id} "${d.title}" (verified)`);
  },
};

export default command;
