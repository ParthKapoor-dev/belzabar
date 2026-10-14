import { type CommandModule, defineArgs, isObj, ok, str } from "@belzabar/core";
import { countRows, runReport } from "../../lib/api";
import { readReport, savedConfiguration } from "../../lib/definition";
import { parseReportId, REPORT_ID_POSITIONAL } from "../../lib/report-id";

interface RunArgs {
  id: string;
  limit: number;
  offset: number;
  count: boolean;
}

interface RunData {
  id: string;
  title: string;
  columns: string[];
  /** One object per row, keyed by column name (values as the server returns them: strings). */
  rows: Array<Record<string, unknown>>;
  returned: number;
  offset: number;
  /** Total rows of the report with its saved filters (`--count`), else null. */
  totalRows: number | null;
}

export const args = defineArgs({
  command: "wi-impl rd run",
  positionals: [REPORT_ID_POSITIONAL],
  flags: {
    limit: { type: "number", integer: true, min: 1, max: 5000, default: 20 },
    offset: { type: "number", integer: true, min: 0, default: 0 },
    count: { type: "boolean" },
  },
});

/** The server returns rows column-major: `data.columns[].data[]`. */
function rowsOf(result: unknown): { columns: string[]; rows: Array<Record<string, unknown>> } {
  const data = isObj(result) && isObj(result.data) ? result.data : {};
  const cols = Array.isArray(data.columns) ? data.columns.filter(isObj) : [];
  const columns = cols.map((c) => str(c.name) ?? str(c.label) ?? String(c.id ?? ""));
  const height = Math.max(0, ...cols.map((c) => (Array.isArray(c.data) ? c.data.length : 0)));
  const rows = Array.from({ length: height }, (_, i) =>
    Object.fromEntries(cols.map((c, j) => [columns[j]!, Array.isArray(c.data) ? c.data[i] ?? null : null])),
  );
  return { columns, rows };
}

const command: CommandModule<RunArgs, RunData> = {
  // Runs the datasource method on the server and bumps the report's version counter.
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { id: parseReportId(positionals.id), limit: flags.limit, offset: flags.offset, count: flags.count };
  },
  async execute({ id, limit, offset, count }) {
    const report = await readReport(id);
    const configuration = savedConfiguration(report);
    const result = await runReport(id, configuration, { offset, limit });
    const { columns, rows } = rowsOf(result);
    const totalRows = count ? await countRows(id, configuration) : null;
    return ok<RunData>({ id, title: report.meta.title, columns, rows, returned: rows.length, offset, totalRows });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as RunData;
    ui.section(`${d.title}: ${d.returned} row(s)${d.offset ? ` from ${d.offset}` : ""}${d.totalRows !== null ? ` of ${d.totalRows}` : ""}`);
    if (d.rows.length === 0) ui.text("(no rows)");
    else ui.table(d.columns, d.rows.map((r) => d.columns.map((c) => (r[c] === null || r[c] === undefined ? "" : String(r[c])))));
  },
};

export default command;
