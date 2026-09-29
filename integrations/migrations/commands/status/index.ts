import { Config, ok, type CommandModule } from "@belzabar/core";
import { assertJenkinsAuth, buildNumberArgs, parseBuildNumber, getBuild } from "../../lib";
import type { MigrateStatusArgs, MigrateStatusData } from "../../lib";

export const args = buildNumberArgs("status");

const command: CommandModule<MigrateStatusArgs, MigrateStatusData> = {
  parseArgs(argv) {
    return { action: "status", buildNumber: parseBuildNumber(args.parse(argv).positionals.buildNumber) };
  },
  async execute(args) {
    const auth = assertJenkinsAuth(Config.getJenkins());
    const build = await getBuild(auth, args.buildNumber);
    return ok<MigrateStatusData>({ action: "status", build });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const { build } = envelope.data as MigrateStatusData;
    ui.table(
      ["Property", "Value"],
      [
        ["Build", `#${build.number}`],
        ["URL", build.url],
        ["Building", build.building ? "Yes" : "No"],
        ["Result", build.result ?? "(running)"],
        ["Duration", `${(build.duration / 1000).toFixed(1)}s`],
        ["Started", new Date(build.timestamp).toISOString()],
      ]
    );
    const params = build.actions
      ?.find((a) => Array.isArray(a.parameters))
      ?.parameters?.map((p) => [p.name, String(p.value)]);
    if (params && params.length > 0) {
      ui.section("Parameters");
      ui.table(["Name", "Value"], params);
    }
  },
};

export default command;
