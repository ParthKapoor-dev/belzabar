import { CliError, Config, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { assertJenkinsAuth, getFullConsole, stripAnsi } from "../../lib";
import type { MigrateLogsArgs, MigrateLogsData } from "../../lib";

export const args = defineArgs({
  command: "belz migrate logs",
  positionals: [
    {
      name: "build-number",
      required: true,
      missingCode: "MIGRATE_BUILD_NUMBER_REQUIRED",
      missingMessage: "belz migrate logs requires a build number.",
    },
  ],
});

/** MG-6: digits only — `12abc` used to be read as build 12. */
function parseBuildNumber(input: string): number {
  const n = /^\d+$/.test(input.trim()) ? Number(input.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliError(`Invalid build number '${input}'.`, { code: "MIGRATE_BUILD_NUMBER_INVALID", details: { input } });
  }
  return n;
}

const command: CommandModule<MigrateLogsArgs, MigrateLogsData> = {
  schema: "belz.migrate.logs",
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
