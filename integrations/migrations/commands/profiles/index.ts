import { Config, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { assertJenkinsAuth, discoverProfiles, normalizeClient } from "../../lib";
import type { MigrateProfilesArgs, MigrateProfilesData } from "../../lib";

export const args = defineArgs({
  command: "belz migrate profiles",
  flags: {
    refresh: { type: "boolean" },
    client: { type: "string" },
  },
});

const command: CommandModule<MigrateProfilesArgs, MigrateProfilesData> = {
  schema: "belz.migrate.profiles",
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    // MG-3: --client used to be hardcoded to undefined, so every client was listed.
    return { action: "profiles", refresh: flags.refresh, client: normalizeClient(flags.client) };
  },
  async execute(args) {
    const auth = assertJenkinsAuth(Config.getJenkins());
    const resolution = await discoverProfiles(auth, { refresh: args.refresh });
    const groups = args.client
      ? resolution.groups.filter((g) => g.client === args.client)
      : resolution.groups;
    return ok<MigrateProfilesData>({
      action: "profiles",
      source: resolution.source,
      fetchedAt: resolution.fetchedAt,
      groups,
      flat: groups.flatMap((g) => g.profiles),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as MigrateProfilesData;
    ui.success(`Resolved ${data.flat.length} profile(s) across ${data.groups.length} client(s) [source: ${data.source}].`);
    for (const group of data.groups) {
      ui.section(group.client);
      if (group.profiles.length === 0) {
        ui.text("(none)");
        continue;
      }
      ui.table(["Profile"], group.profiles.map((p) => [p]));
    }
  },
};

export default command;
