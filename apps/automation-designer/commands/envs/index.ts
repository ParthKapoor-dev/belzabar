import { Config } from "../../lib/config";

export async function run(args: string[]) {
  const envs = Config.getAllEnvs();
  const active = Config.activeEnv;

  console.log("Available Environments:\n");
  console.log(`Project: NSM`); // Grouping by project as requested

  for (const key of Object.keys(envs)) {
    const env = envs[key];
    const isDefault = env.name === active.name;
    const marker = isDefault ? "*" : " ";
    const suffix = isDefault ? " [Active]" : "";
    
    console.log(`  ${marker} ${env.name.padEnd(10)} (${env.baseUrl})${suffix}`);
  }
  console.log("");
}
