import { type CommandModule, defineArgs, ok } from "@belzabar/core";
import { readReport, type ReportMeta, type SavedReport } from "../../lib/definition";
import { parseReportId, REPORT_ID_POSITIONAL } from "../../lib/report-id";
import { columnViews, filterViews, summaryViews, type ColumnView, type FilterView } from "../../lib/view";

interface ShowArgs {
  id: string;
  exact: boolean;
}

interface ShowData extends ReportMeta {
  description: string | null;
  dataSource: SavedReport["dataSource"];
  columns: ColumnView[];
  filters: FilterView[];
  summaries: string[];
  isFilterRequired: boolean;
  summaryPosition: unknown;
  filterConfig: number | null;
  /** Settings not read (they need --exact, which runs the report). */
  unread: string[];
}

export const args = defineArgs({
  command: "belz rd show",
  positionals: [REPORT_ID_POSITIONAL],
  flags: { exact: { type: "boolean" } },
});

const command: CommandModule<ShowArgs, ShowData> = {
  // --exact runs the report on the server.
  writes: (a) => a.exact,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { id: parseReportId(positionals.id), exact: flags.exact };
  },
  async execute({ id, exact }, context) {
    const r = await readReport(id, { exact });
    if (!r.dataSource.id) context.warn("This report has no datasource saved yet.");
    else if (!r.dataSource.category || !r.dataSource.method) {
      context.warn("The datasource is no longer listed (unpublished, deleted or moved category?); the report will fail to run.");
    }
    return ok<ShowData>({
      ...r.meta,
      description: r.spec.description ?? null,
      dataSource: r.dataSource,
      columns: columnViews(r.spec.columns),
      filters: filterViews(r.spec.filters, r.spec.columns),
      summaries: summaryViews(r.spec.summaries),
      isFilterRequired: r.spec.isFilterRequired ?? false,
      summaryPosition: r.spec.summaryPosition ?? null,
      filterConfig: r.spec.filterConfig ?? null,
      unread: r.unread,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as ShowData;
    ui.section(`${d.title} (${d.id})`);
    if (d.description) ui.kv("Description", d.description);
    ui.kv("Status", d.status ?? "-");
    const ds = d.dataSource;
    ui.kv("Datasource", ds.method ? `${ds.category ?? "?"} / ${ds.method} (chain ${ds.id ?? "?"})` : ds.id ? `chain ${ds.id} (not listed)` : "(none)");
    ui.kv("Updated", d.updatedAt ?? "-");
    ui.kv("Last run", d.lastExecutedAt ?? "-");
    ui.section(`Columns (${d.columns.length})`);
    ui.table(
      ["Name", "Label", "Type", "Filterable", "Shown"],
      d.columns.map((c) => [c.name, c.label === c.name ? "" : c.label, c.type, c.filterable ? "yes" : "", c.reportable ? "yes" : "no"]),
    );
    if (d.filters.length > 0) {
      ui.section(`Saved filters (${d.filters.length})`);
      for (const f of d.filters) ui.text(`${f.column} ${f.operator} ${JSON.stringify(f.value)}${f.applied ? "" : " (not applied)"}`);
    }
    if (d.summaries.length > 0) ui.kv("Summaries", d.summaries.join(", "));
    if (d.isFilterRequired) ui.kv("Filter required", "yes");
  },
};

export default command;
