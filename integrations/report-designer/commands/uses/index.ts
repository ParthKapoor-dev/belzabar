import { type CommandModule, defineArgs, ok, str } from "@belzabar/core";
import { resolveMethodRef } from "@belzabar/core/platform";
import { dependentReports } from "../../lib/api";

interface UsesArgs {
  uuid: string;
}

interface UsesData {
  methodUuid: string;
  total: number;
  reports: Array<{ id: string; title: string }>;
}

export const args = defineArgs({
  command: "belz rd uses",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument (an AD method uuid or URL)." }],
});

const command: CommandModule<UsesArgs, UsesData> = {
  parseArgs(argv) {
    const { positionals } = args.parse(argv);
    return { uuid: resolveMethodRef(positionals.uuid) };
  },
  async execute({ uuid }) {
    const rows = await dependentReports(uuid);
    const reports = rows.map((r) => ({ id: str(r.uuid)?.trim() ?? "", title: str(r.reportName) ?? "" })).filter((r) => r.id);
    return ok<UsesData>({ methodUuid: uuid, total: reports.length, reports });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as UsesData;
    ui.section(`Reports using ${d.methodUuid} (${d.total})`);
    if (d.total === 0) ui.text("(none)");
    else ui.table(["ID", "Title"], d.reports.map((r) => [r.id, r.title]));
  },
};

export default command;
