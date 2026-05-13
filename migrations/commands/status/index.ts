import { CliError, Config, ok, type CommandModule } from "@belzabar/core";
import { assertJenkinsAuth, getBuild } from "../../lib";
import type { MigrateStatusArgs, MigrateStatusData } from "../../lib";

const command: CommandModule<MigrateStatusArgs, MigrateStatusData> = {
  schema: "belz.migrate.status",
  parseArgs(args) {
    const first = args.find((a) => !a.startsWith("-"));
    if (!first) {
      throw new CliError("belz migrate status requires a build number.", {
        code: "MIGRATE_BUILD_NUMBER_REQUIRED",
      });
    }
    const n = Number.parseInt(first, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new CliError(`Invalid build number '${first}'.`, { code: "MIGRATE_BUILD_NUMBER_INVALID" });
    }
    return { action: "status", buildNumber: n };
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
