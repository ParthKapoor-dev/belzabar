import { Config } from "@belzabar/core";
import { ok, type CommandModule } from "@belzabar/core";

interface EnvRow {
  name: string;
  project: string;
  baseUrl: string;
  active: boolean;
}

interface EnvsData {
  /** Project of the active env (kept for back-compat with existing consumers). */
  project: string;
  active: string;
  envs: EnvRow[];
}

const command: CommandModule<undefined, EnvsData> = {
  schema: "belz.envs",
  parseArgs: () => undefined,
  async execute() {
  const envs = Config.getAllEnvs();
  const active = Config.activeEnv;
    const rows = Object.values(envs).map((env) => ({
      name: env.name,
      project: env.project,
      baseUrl: env.baseUrl,
      active: env.name === active.name,
    }));

    return ok({
      project: active.project,
      active: active.name,
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
  },
};

export default command;
