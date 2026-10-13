import { type CommandModule, defineArgs, num, ok, str } from "@belzabar/core";
import { listReports, SORT_TYPES } from "../../lib/api";

interface FindArgs {
  query?: string;
  limit: number;
  sort: keyof typeof SORT_TYPES;
  archived: boolean;
}

interface ReportRow {
  id: string;
  title: string;
  dataSource: string | null;
  status: string | null;
  serialId: number | null;
  updatedAt: string | null;
  lastExecutedAt: string | null;
}

interface FindData {
  query: string | null;
  sort: string;
  total: number;
  /** ARCHIVED rows dropped (without --archived). */
  hiddenArchived: number;
  reports: ReportRow[];
}

export const args = defineArgs({
  command: "belz rd find",
  positionals: [{ name: "query", variadic: true }],
  flags: {
    limit: { type: "number", integer: true, min: 1, max: 1000, default: 50 },
    sort: { type: "enum", values: Object.keys(SORT_TYPES), default: "executed" },
    archived: { type: "boolean" },
  },
});

const command: CommandModule<FindArgs, FindData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const query = positionals.query.join(" ").trim();
    return { ...(query ? { query } : {}), limit: flags.limit, sort: flags.sort as FindArgs["sort"], archived: flags.archived };
  },
  async execute({ query, limit, sort, archived }, context) {
    const rows = await listReports({ search: query, sort, limit });
    const all: ReportRow[] = rows.map((r) => ({
      id: str(r.id)?.trim() ?? "",
      title: str(r.title) ?? "",
      dataSource: str(r.dataSourceName)?.trim() || null,
      status: str(r.reportStatus) ?? null,
      serialId: num(r.serialId),
      updatedAt: str(r.updatedAt) ?? null,
      lastExecutedAt: str(r.lastExecutedAt) ?? null,
    }));
    const reports = archived ? all : all.filter((r) => r.status !== "ARCHIVED");
    if (rows.length >= limit) context.warn(`Showing the first ${limit} matches; more may exist (raise --limit or narrow the query).`);
    return ok<FindData>({ query: query ?? null, sort, total: reports.length, hiddenArchived: all.length - reports.length, reports });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as FindData;
    ui.section(`Reports${d.query ? ` matching "${d.query}"` : ""} (${d.total})`);
    if (d.reports.length === 0) ui.text("(none)");
    else {
      ui.table(
        ["ID", "Title", "Datasource", "Status", "Last run"],
        d.reports.map((r) => [r.id, r.title.length > 50 ? `${r.title.slice(0, 47)}...` : r.title, r.dataSource ?? "-", r.status ?? "-", r.lastExecutedAt ?? "-"]),
      );
    }
    if (d.hiddenArchived > 0) ui.info(`${d.hiddenArchived} archived report(s) hidden; pass --archived to list them.`);
  },
};

export default command;
