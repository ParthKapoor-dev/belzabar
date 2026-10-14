import { Config } from "@belzabar/core";
import { defineArgs, ok, type CommandModule } from "@belzabar/core";

interface EnvRow {
  name: string;
  project: string;
  baseUrl: string;
  active: boolean;
}

interface EnvsData {
  /** Active env name; null when no env is selected (no --env / WI_IMPL_ENV / defaultEnv, several envs). */
  active: string | null;
  envs: EnvRow[];
}

export const args = defineArgs({ command: "belz envs" });

const command: CommandModule<undefined, EnvsData> = {
  parseArgs: (argv) => {
    args.parse(argv);
    return undefined;
  },
  async execute() {
    const envs = Config.getAllEnvs();
    const selected = Config.envSource !== "none";
    const active = Config.activeEnv;
    const rows = Object.values(envs).map((env) => ({
      name: env.name,
      project: env.project,
      baseUrl: env.baseUrl,
      active: selected && env.name === active.name,
    }));

    return ok({
      active: selected ? active.name : null,
      envs: rows,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as EnvsData;
    ui.text("Available Environments:");
    ui.table(
      ["Environment", "Project", "Base URL", "Status"],
      data.envs.map((env) => [env.name, env.project, env.baseUrl, env.active ? "Active" : ""])
    );
    if (data.active === null && data.envs.length > 0) {
      ui.text("No active environment: pass --env <name>, set WI_IMPL_ENV, or set \"defaultEnv\" in config.json.");
    }
  },
};

export default command;
