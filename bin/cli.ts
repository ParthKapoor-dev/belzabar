#!/usr/bin/env bun
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { Config } from "../lib/config";

// robust path resolution for runtime
const commandsDir = join(import.meta.dir, "../commands");

async function main() {
  let args = process.argv.slice(2);

  // Parse Global Flags
  const envIndex = args.findIndex(a => a === "--env" || a === "-e");
  if (envIndex !== -1) {
    if (envIndex + 1 >= args.length) {
      console.error("Error: --env flag requires an argument.");
      process.exit(1);
    }
    const envName = args[envIndex + 1];
    try {
      Config.setActiveEnv(envName);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    args.splice(envIndex, 2);
  }

  const activeEnv = Config.activeEnv;
  // Print Context Header (stderr)
  console.warn(`[CLI] 🌍 Environment: ${activeEnv.name} | 👤 User: ${activeEnv.credentials.loginId || "n/a"}`);

  const commandName = args[0];

  // Helper to list commands
  const listCommands = () => {
    console.log("Automation Designer CLI");
    console.log("Usage: belz <command> [args]\n");
    console.log("Available Commands:");
    
    try {
      if (existsSync(commandsDir)) {
        const commands = readdirSync(commandsDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);
        
        commands.forEach(cmd => console.log(`  - ${cmd}`));
      }
    } catch (e) {
      console.error("Error reading commands directory.");
    }
    console.log("\nRun 'belz <command> --help' for details.");
  };

  if (!commandName || commandName === "--help" || commandName === "-h") {
    listCommands();
    process.exit(0);
  }

  const commandPath = join(commandsDir, commandName);

  if (!existsSync(commandPath)) {
    console.error(`Unknown command: ${commandName}`);
    listCommands();
    process.exit(1);
  }

  // Check for Command Help
  if (args[1] === "--help" || args[1] === "-h") {
    const helpFile = Bun.file(join(commandPath, "help.txt"));
    if (await helpFile.exists()) {
      console.log(await helpFile.text());
    } else {
      console.log(`No help file found for '${commandName}'.`);
    }
    process.exit(0);
  }

  // Execute Command
  try {
    const modulePath = join(commandPath, "index.ts");
    // Dynamic import works in runtime
    const module = await import(modulePath);
    
    if (typeof module.run !== "function") {
      console.error(`Error: Command '${commandName}' does not export a 'run' function.`);
      process.exit(1);
    }

    await module.run(args.slice(1));

  } catch (error) {
    console.error(`Error executing command '${commandName}':`, error);
    process.exit(1);
  }
}

main();
