// wi-impl pd hosts — the hosts PD pages can be deployed to (read only).
//
// GET /rest/api/pagedesigner/deployable/hosts. The ids are what
// `wi-impl pd publish --host <id>` takes; a page's current ones are in
// `wi-impl pd show <page>` (summary.hostIds).

import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { pdApi } from "../../lib/api/index";

interface HostRow {
  id: number;
  domain: string | null;
  nickname: string | null;
  description: string | null;
}

interface HostsData {
  count: number;
  hosts: HostRow[];
}

export const args = defineArgs({ command: "wi-impl pd hosts", flags: {} });

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

const command: CommandModule<Record<string, never>, HostsData> = {
  parseArgs(argv) {
    args.parse(argv);
    return {};
  },

  async execute() {
    const hosts = (await pdApi.fetchDeployableHosts())
      .map((h) => ({ id: Number(h.id), domain: str(h.domain), nickname: str(h.nickname), description: str(h.description) }))
      .sort((a, b) => a.id - b.id);
    return ok<HostsData>({ count: hosts.length, hosts });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok || !envelope.data) return;
    const { hosts } = envelope.data as HostsData;
    if (hosts.length === 0) {
      ui.info("No deployable hosts.");
      return;
    }
    ui.table(["Id", "Nickname", "Domain", "Description"], hosts.map((h) => [h.id, h.nickname ?? "", h.domain ?? "", h.description ?? ""]));
    ui.info("Deploy with `wi-impl pd publish <pageId> --host <id> --yes` (or --hosts-from-current).");
  },
};

export default command;
