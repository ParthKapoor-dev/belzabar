import { CliError, Config, ok, type CommandModule } from "@belzabar/core";
import { assertJenkinsAuth, getFullConsole, stripAnsi } from "../../lib";
import type { MigrateLogsArgs, MigrateLogsData } from "../../lib";

const command: CommandModule<MigrateLogsArgs, MigrateLogsData> = {
  schema: "belz.migrate.logs",
  parseArgs(args) {
    const first = args.find((a) => !a.startsWith("-"));
    if (!first) {
      throw new CliError("belz migrate logs requires a build number.", {
        code: "MIGRATE_BUILD_NUMBER_REQUIRED",
      });
    }
    const n = Number.parseInt(first, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new CliError(`Invalid build number '${first}'.`, { code: "MIGRATE_BUILD_NUMBER_INVALID" });
    }
    return { action: "logs", buildNumber: n };
  },
  async execute(args) {
    const auth = assertJenkinsAuth(Config.getJenkins());
    const raw = await getFullConsole(auth, args.buildNumber);
    return ok<MigrateLogsData>({
      action: "logs",
      buildNumber: args.buildNumber,
      consoleText: stripAnsi(raw),
      truncated: false,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as MigrateLogsData;
    ui.section(`Console — build #${data.buildNumber}`);
    ui.text(data.consoleText);
  },
};

export default command;
