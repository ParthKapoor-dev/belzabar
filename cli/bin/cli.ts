#!/usr/bin/env bun
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { runNamespacedCli } from "@belzabar/core";

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

function makeHelpDirResolver(dir: string) {
  return async (cmd: string): Promise<string | null> => {
    const p = join(dir, cmd, "help.txt");
    try {
      const file = Bun.file(p);
      if (await file.exists()) return await file.text();
    } catch { /* ignore */ }
    return null;
  };
}

const adCommands = loadCommandsFromDir(adCommandsDir);
const pdCommands = loadCommandsFromDir(pdCommandsDir);
const allTopCommands = loadCommandsFromDir(topCommandsDir);
const { migrate, ...topLevelCommands } = allTopCommands;

await runNamespacedCli(process.argv, {
  name: "Belzabar CLI",
  description: "Unified CLI for Automation Designer and Page Designer.",
  binaryName: "belz",
  namespaces: {
    ad: {
      name: "Automation Designer",
      description: "Interact with Automation Designer APIs.",
      commands: adCommands,
      helpDir: adCommandsDir,
    },
    pd: {
      name: "Page Designer",
      description: "Analyze Page Designer configuration.",
      commands: pdCommands,
      helpDir: pdCommandsDir,
    },
    migrate: {
      name: "Migrations",
      description: "Run NSM database migrations.",
      command: migrate,
      helpResolver: makeHelpDirResolver(topCommandsDir),
    },
  },
  topLevel: topLevelCommands,
  topLevelHelpDir: topCommandsDir,
});
