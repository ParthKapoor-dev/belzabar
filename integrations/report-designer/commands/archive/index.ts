import { CliError, type CommandModule, defineArgs, ok, str } from "@belzabar/core";
import { getReportBasic, patchReport } from "../../lib/api";
import { logIntent, requireConfirmation } from "../../lib/confirm";
import { parseReportId, REPORT_ID_POSITIONAL } from "../../lib/report-id";

interface ArchiveArgs {
  id: string;
  restore: boolean;
  yes: boolean;
}

interface ArchiveData {
  id: string;
  title: string;
  before: string | null;
  status: string | null;
  changed: boolean;
}

export const args = defineArgs({
  command: "belz rd archive",
  positionals: [REPORT_ID_POSITIONAL],
  flags: {
    restore: { type: "boolean" },
    yes: { type: "boolean", alias: ["-y"] },
  },
});

const command: CommandModule<ArchiveArgs, ArchiveData> = {
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { id: parseReportId(positionals.id), restore: flags.restore, yes: flags.yes };
  },
  async execute({ id, restore, yes }, context) {
    const target = restore ? "ACTIVE" : "ARCHIVED";
    const record = await getReportBasic(id);
    const title = str(record.title) ?? "";
    const before = str(record.reportStatus) ?? null;
    if (before === target) {
      context.warn(`Report ${id} is already ${target}.`);
      return ok<ArchiveData>({ id, title, before, status: before, changed: false });
    }
    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `${restore ? "unarchive" : "archive"} report ${id} ("${title}") on ${context.env.name}`,
      details: [
        ["Report", `${title} (${id})`],
        ["Status", `${before ?? "?"} → ${target}`],
      ],
    });
    logIntent("PATCH", `/rest/api/v2/reports/${id}?execute=true`, { id, reportStatus: target });
    await patchReport(id, { reportStatus: target }, { execute: true });
    const status = str((await getReportBasic(id)).reportStatus) ?? null;
    if (status !== target) {
      throw new CliError(`Report ${id} reads back as ${status ?? "?"}, not ${target}.`, { code: "RD_VERIFY_FAILED", details: { id, status, expected: target } });
    }
    return ok<ArchiveData>({ id, title, before, status, changed: true });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as ArchiveData;
    if (d.changed) ui.success(`Report ${d.id} "${d.title}": ${d.before} → ${d.status}`);
  },
};

export default command;
