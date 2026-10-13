import { CliError, Config, type CommandModule, defineArgs, failWithData, ok, str } from "@belzabar/core";
import { listReports } from "../../lib/api";
import { requireConfirmation } from "../../lib/confirm";
import { resolveDataSource, type ResolvedDataSource } from "../../lib/datasource";
import { readReport, type ReportSpec } from "../../lib/definition";
import { parseReportId, REPORT_ID_POSITIONAL } from "../../lib/report-id";
import { applySave, createReport, planSave } from "../../lib/write";

interface CopyArgs {
  id: string;
  fromEnv: string;
  into?: string;
  title?: string;
  exact: boolean;
  yes: boolean;
  dryRun: boolean;
}

interface CopyData {
  from: { env: string; id: string; title: string };
  to: { env: string; id: string | null; mode: "create" | "update" };
  dryRun: boolean;
  /** The datasource on the target env (same category and method name as on the source). */
  dataSource: ResolvedDataSource;
  /** `--into`: what changes on the target report. */
  changes: string[];
  /** Display settings not carried over (no --exact): defaults on create, kept on update. */
  unread: string[];
  /** Ids of reports on the target env with the same title (create only). */
  sameTitle: string[];
  backup: string | null;
  mismatches: string[];
}

export const args = defineArgs({
  command: "belz rd copy",
  positionals: [REPORT_ID_POSITIONAL],
  flags: {
    "from-env": { type: "string", required: true, missingCode: "MISSING_FROM_ENV", missingMessage: "Pass --from-env <env>: the env the report is copied from (--env is the target)." },
    into: { type: "string" },
    title: { type: "string" },
    exact: { type: "boolean" },
    yes: { type: "boolean", alias: ["-y"] },
    "dry-run": { type: "boolean" },
  },
});

const command: CommandModule<CopyArgs, CopyData> = {
  // The target is --env; the source is only read (unless --exact, which runs it there).
  writes: (a) => !a.dryRun,
  requiresEnv: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const title = flags.title?.trim();
    return {
      id: parseReportId(positionals.id),
      fromEnv: flags.fromEnv.trim(),
      ...(flags.into ? { into: parseReportId(flags.into) } : {}),
      ...(title ? { title } : {}),
      exact: flags.exact,
      yes: flags.yes,
      dryRun: flags.dryRun,
    };
  },
  async execute({ id, fromEnv, into, title, exact, yes, dryRun }, context) {
    const target = context.env.name;
    if (fromEnv === target) {
      throw new CliError(`--from-env and --env are both ${target}; to duplicate a report on one env, export it and use 'belz rd create'.`, {
        code: "RD_SAME_ENV",
        details: { env: target },
      });
    }
    // Read on the source env (in-process; the active env is restored afterwards).
    const source = await Config.withEnv(fromEnv, () => readReport(id, { exact }));
    if (!source.spec.dataSource.category || !source.spec.dataSource.method) {
      throw new CliError(`The source report's datasource is not listed on ${fromEnv} (unpublished or removed); nothing to map it to.`, {
        code: "RD_DATASOURCE_NOT_FOUND",
        details: { env: fromEnv, id, dataSourceId: source.dataSource.id },
      });
    }
    const spec: ReportSpec = { ...source.spec, ...(title ? { title } : {}) };

    let ds: ResolvedDataSource;
    try {
      ds = await resolveDataSource(spec.dataSource);
    } catch (err) {
      if (err instanceof CliError && err.code.startsWith("RD_DATASOURCE")) {
        const head = err.code === "RD_DATASOURCE_NOT_FOUND" ? `No published method '${spec.dataSource.method}' in category '${spec.dataSource.category}' on ${target}.` : err.message;
        throw new CliError(`${head} Migrate the AD method to ${target} first (belz migrate run --module AD_Method …), then copy again.`, {
          code: err.code,
          details: err.details,
        });
      }
      throw err;
    }

    const from = { env: fromEnv, id, title: source.meta.title };
    const common = { from, dataSource: ds, unread: source.unread, backup: null, mismatches: [] as string[] };

    if (into) {
      const plan = await planSave(into, spec, { dryRun });
      const data: CopyData = { ...common, to: { env: target, id: into, mode: "update" }, dryRun, changes: plan.changes, sameTitle: [] };
      if (plan.changes.length === 0) {
        context.warn(`Report ${into} on ${target} already matches; nothing to copy.`);
        return ok(data);
      }
      if (dryRun) return ok(data);
      await requireConfirmation({
        yes,
        outputMode: context.outputMode,
        action: `overwrite report ${into} ("${plan.current.meta.title}") on ${target} with ${fromEnv} report ${id}`,
        details: [
          ["From", `${fromEnv}: ${source.meta.title} (${id})`],
          ["Into", `${target}: ${plan.current.meta.title} (${into})`],
          ["Datasource", `${ds.category} / ${ds.method} (chain ${ds.id} on ${target})`],
          ["Changes", plan.changes.join("\n")],
        ],
      });
      const { backup, mismatches } = await applySave(into, plan, ds);
      const done: CopyData = { ...data, backup, mismatches };
      if (mismatches.length > 0) return failWithData("RD_VERIFY_FAILED", `Report ${into} was saved but reads back different: ${mismatches.join("; ")}.`, done);
      return ok(done);
    }

    const sameTitle = (await listReports({ search: spec.title, sort: "created", limit: 100 }))
      .filter((r) => str(r.title) === spec.title)
      .map((r) => str(r.id)?.trim() ?? "");
    if (sameTitle.length > 0) {
      context.warn(`${target} already has ${sameTitle.length} report(s) titled "${spec.title}" (${sameTitle.join(", ")}); pass --into <id> to update one instead of adding another.`);
    }
    const data: CopyData = { ...common, to: { env: target, id: null, mode: "create" }, dryRun, changes: [], sameTitle };
    if (dryRun) return ok(data);
    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `create a copy of ${fromEnv} report ${id} on ${target}`,
      details: [
        ["From", `${fromEnv}: ${source.meta.title} (${id})`],
        ["New report", `${target}: ${spec.title}`],
        ["Datasource", `${ds.category} / ${ds.method} (chain ${ds.id} on ${target})`],
      ],
    });
    const result = await createReport(spec, ds);
    const done: CopyData = { ...data, to: { ...data.to, id: result.id }, mismatches: result.mismatches };
    if (result.mismatches.length > 0) return failWithData("RD_VERIFY_FAILED", `Report ${result.id} was created but reads back different: ${result.mismatches.join("; ")}.`, done);
    return ok(done);
  },
  presentHuman(envelope, ui) {
    const d = envelope.data as CopyData | null;
    if (!d) return;
    const where = `${d.from.env} ${d.from.id} → ${d.to.env} ${d.to.id ?? "(new)"}`;
    ui.section(d.dryRun ? `Dry run: copy ${where}` : `Copied ${where}`);
    ui.kv("Datasource", `${d.dataSource.category} / ${d.dataSource.method} (chain ${d.dataSource.id} on ${d.to.env})`);
    for (const c of d.changes) ui.text(`• ${c}`);
    if (d.unread.length > 0) ui.info(`Not copied without --exact: ${d.unread.join(", ")} (${d.to.mode === "create" ? "defaults used" : "target's kept"}).`);
    if (d.backup) ui.info(`Previous target definition: ${d.backup}`);
    if (envelope.ok && !d.dryRun) ui.success("Read back and verified");
  },
};

export default command;
