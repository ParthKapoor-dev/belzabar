#!/usr/bin/env bun
import { existsSync } from "fs";
import { join } from "path";
import { Config } from "../lib/config";
import { DisplayManager } from "../lib/display";
import { CommandRegistry } from "../commands";

// robust path resolution for runtime
const commandsDir = join(import.meta.dir, "../commands");

async function main() {
  let args = process.argv.slice(2);

  // Check for LLM flag immediately
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
    const envName = args[envIndex + 1];
    try {
      Config.setActiveEnv(envName);
    } catch (e: any) {
      DisplayManager.error(`Error: ${e.message}`);
      process.exit(1);
    }
    args.splice(envIndex, 2);
  }

  const activeEnv = Config.activeEnv;
  // Print Context Header (stderr)
  DisplayManager.info(`🌍 Environment: ${activeEnv.name} | 👤 User: ${activeEnv.credentials.loginId || "n/a"}`);

  const commandName = args[0];

  // Helper to list commands
  const listCommands = () => {
    if (DisplayManager.isLLM) return; // Don't print help in LLM mode
    
    console.log("Automation Designer CLI");
    console.log("Usage: belz <command> [args]\n");
    console.log("Available Commands:");
    
    Object.keys(CommandRegistry).forEach(cmd => console.log(`  - ${cmd}`));
    
    console.log("\nRun 'belz <command> --help' for details.");
  };

  if (!commandName || commandName === "--help" || commandName === "-h") {
    listCommands();
    process.exit(0);
  }

  if (!CommandRegistry[commandName]) {
    DisplayManager.error(`Unknown command: ${commandName}`);
    listCommands();
    process.exit(1);
  }

  // Check for Command Help
  if (args[1] === "--help" || args[1] === "-h") {
    if (DisplayManager.isLLM) process.exit(0); // Silent exit

    // Try to read help.txt from source location if available
    const commandPath = join(commandsDir, commandName);
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
    const module = CommandRegistry[commandName];
    
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

main();
