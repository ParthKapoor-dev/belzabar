import { Config } from "@belzabar/core";
import { ok, type CommandModule } from "@belzabar/core";

interface EnvRow {
  name: string;
  baseUrl: string;
  active: boolean;
}

interface EnvsData {
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
    const rows = Object.keys(envs).map((key) => {
      const env = envs[key];
      return {
        name: env.name,
        baseUrl: env.baseUrl,
        active: env.name === active.name,
      };
    });

    return ok({
      project: "NSM",
      active: active.name,
      envs: rows,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as EnvsData;
    ui.text("Available Environments:");
    ui.text(`Project: ${data.project}`);
    ui.table(
      ["Environment", "Base URL", "Status"],
      data.envs.map((env) => [env.name, env.baseUrl, env.active ? "Active" : ""])
    );
  },
};

export default command;
