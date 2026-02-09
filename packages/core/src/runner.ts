import { Config } from "./config";
import { DisplayManager } from "./display";

export interface CliOptions {
    name: string;
    description: string;
    binaryName: string;
}

export async function runCli(
    argv: string[], 
    commandMap: Record<string, any>, 
    options: CliOptions,
    helpResolver?: (cmd: string) => Promise<string | null>
) {
  let args = argv.slice(2);

  // Check for LLM flag
  const llmIndex = args.indexOf("--llm");
  if (llmIndex !== -1) {
    DisplayManager.configure({ llm: true });
    args.splice(llmIndex, 1);
  }

  // Parse Global Flags
  const envIndex = args.findIndex(a => a === "--env" || a === "-e");
  if (envIndex !== -1) {
    if (envIndex + 1 >= args.length) {
      DisplayManager.error("Error: --env flag requires an argument.");
      process.exit(1);
    }
    const envName = args[envIndex + 1] as string;
    try {
      Config.setActiveEnv(envName);
    } catch (e: any) {
      DisplayManager.error(`Error: ${e.message}`);
      process.exit(1);
    }
    args.splice(envIndex, 2);
  }

  const activeEnv = Config.activeEnv;
  DisplayManager.info(`🌍 Environment: ${activeEnv.name} | 👤 User: ${activeEnv.credentials.loginId || "n/a"}`);

  const commandName = args[0];

  // Helper to list commands
  const listCommands = () => {
    if (DisplayManager.isLLM) return;

    console.log(options.name);
    console.log(options.description);
    console.log(`Usage: ${options.binaryName} <command> [args]
`);
    console.log("Available Commands:");

    Object.keys(commandMap).forEach(cmd => console.log(`  - ${cmd}`));

    console.log(`
Run '${options.binaryName} <command> --help' for details.`);
  };

  if (!commandName || commandName === "--help" || commandName === "-h") {
    listCommands();
    process.exit(0);
  }

  if (!commandMap[commandName]) {
    DisplayManager.error(`Unknown command: ${commandName}`);
    listCommands();
    process.exit(1);
  }

  // Check for Command Help
  if (args[1] === "--help" || args[1] === "-h") {
    if (DisplayManager.isLLM) process.exit(0);

    let helpText: string | null = null;
    if (helpResolver) {
      helpText = await helpResolver(commandName);
    }

    if (helpText) {
      console.log(helpText);
    } else {
      console.log(`No help file found for '${commandName}'.`);
    }
    process.exit(0);
  }

  // Execute Command
  try {
    const module = commandMap[commandName];

    if (typeof module.run !== "function") {
      DisplayManager.error(`Error: Command '${commandName}' does not export a 'run' function.`);
      process.exit(1);
    }

    await module.run(args.slice(1));

  } catch (error) {
    DisplayManager.error(`Error executing command '${commandName}': ${error}`);
    process.exit(1);
  }
}
