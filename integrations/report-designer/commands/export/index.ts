import { writeFileSync } from "fs";
import { resolve } from "path";
import { CliError, type CommandModule, defineArgs, ok } from "@belzabar/core";
import { readReport, type ReportSpec } from "../../lib/definition";
import { parseReportId, REPORT_ID_POSITIONAL } from "../../lib/report-id";

interface ExportArgs {
  id: string;
  out?: string;
  exact: boolean;
}

interface ExportData {
  id: string;
  spec: ReportSpec;
  /** Spec fields left out (they need --exact); the defaults apply to them. */
  unread: string[];
  /** Absolute path written (--out). */
  path: string | null;
}

export const args = defineArgs({
  command: "wi-impl rd export",
  positionals: [REPORT_ID_POSITIONAL],
  flags: {
    out: { type: "string", alias: ["-o"] },
    exact: { type: "boolean" },
  },
});

const command: CommandModule<ExportArgs, ExportData> = {
  writesLocal: true,
  writes: (a) => a.exact,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { id: parseReportId(positionals.id), ...(flags.out ? { out: flags.out } : {}), exact: flags.exact };
  },
  async execute({ id, out, exact }, context) {
    const r = await readReport(id, { exact });
    if (!r.spec.dataSource.category || !r.spec.dataSource.method) {
      context.warn("The datasource could not be named (not listed on this env); fill dataSource in before using the spec.");
    }
    let path: string | null = null;
    if (out) {
      path = resolve(out);
      try {
        writeFileSync(path, `${JSON.stringify(r.spec, null, 2)}\n`);
      } catch (err) {
        throw new CliError(`Cannot write ${path}: ${(err as Error).message}`, { code: "RD_WRITE_FILE_FAILED", details: { path } });
      }
    }
    return ok<ExportData>({ id, spec: r.spec, unread: r.unread, path });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as ExportData;
    if (d.path) ui.success(`Wrote ${d.path}`);
    else ui.text(JSON.stringify(d.spec, null, 2));
    if (d.unread.length > 0) ui.info(`Not included (need --exact, which runs the report): ${d.unread.join(", ")}; the defaults apply to them.`);
  },
};

export default command;
