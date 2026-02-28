#!/usr/bin/env bun
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { runBelzCli } from "../lib/runner";

// Dev Mode: Discover commands dynamically
const adCommandsDir = join(import.meta.dir, "../../automation-designer/commands");
const pdCommandsDir = join(import.meta.dir, "../../page-designer/commands");
const topCommandsDir = join(import.meta.dir, "../commands"); // cli/commands/ (envs, migrate)

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

const adCommands = loadCommandsFromDir(adCommandsDir);
const topLevelCommands = loadCommandsFromDir(topCommandsDir);
const pdCommands = loadCommandsFromDir(pdCommandsDir);

await runBelzCli(process.argv, adCommands, pdCommands, topLevelCommands, {
  ad: adCommandsDir,
  pd: pdCommandsDir,
  top: topCommandsDir,
});
