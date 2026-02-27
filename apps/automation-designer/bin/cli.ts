#!/usr/bin/env bun
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { runBelzCli } from "../lib/runner";

// Dev Mode: Discover commands dynamically
const adCommandsDir = join(import.meta.dir, "../commands");
const pdCommandsDir = join(import.meta.dir, "../../page-designer/commands");

const TOP_LEVEL_COMMANDS = new Set(["migrate", "envs"]);

function loadCommandsFromDir(dir: string): Record<string, any> {
  const map: Record<string, any> = {};
  if (!existsSync(dir)) return map;
  const items = readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.isDirectory() && !item.name.startsWith(".")) {
      try {
        const modulePath = join(dir, item.name, "index.ts");
        if (existsSync(modulePath)) {
          map[item.name] = require(modulePath);
        }
      } catch {
        // ignore invalid folders
      }
    }
  }
  return map;
}

const allAdCommands = loadCommandsFromDir(adCommandsDir);
const adCommands: Record<string, any> = {};
const topLevelCommands: Record<string, any> = {};

for (const [name, mod] of Object.entries(allAdCommands)) {
  if (TOP_LEVEL_COMMANDS.has(name)) {
    topLevelCommands[name] = mod;
  } else {
    adCommands[name] = mod;
  }
}

const pdCommands = loadCommandsFromDir(pdCommandsDir);

await runBelzCli(process.argv, adCommands, pdCommands, topLevelCommands, {
  ad: adCommandsDir,
  pd: pdCommandsDir,
  top: adCommandsDir,
});
