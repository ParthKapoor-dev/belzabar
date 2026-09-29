import { Config, ok, type CommandModule } from "@belzabar/core";
import { assertJenkinsAuth, buildNumberArgs, parseBuildNumber, getFullConsole, stripAnsi } from "../../lib";
import type { MigrateLogsArgs, MigrateLogsData } from "../../lib";

export const args = buildNumberArgs("logs");

const command: CommandModule<MigrateLogsArgs, MigrateLogsData> = {
  parseArgs(argv) {
    return { action: "logs", buildNumber: parseBuildNumber(args.parse(argv).positionals.buildNumber) };
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
