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

async function buildHelpFullDynamic(): Promise<string> {
  const RULE = "─".repeat(77);

  function discoverCmds(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => e.name);
    } catch { return []; }
  }

  async function readDesc(dir: string, cmd: string): Promise<string | null> {
    const p = join(dir, cmd, "desc.txt");
    try {
      const f = Bun.file(p);
      if (await f.exists()) return (await f.text()).trimEnd();
    } catch {}
    return null;
  }

  const sections = [
    { header: "belz ad <cmd>  —  Automation Designer", dir: adCommandsDir },
    { header: "belz pd <cmd>  —  Page Designer",       dir: pdCommandsDir },
    { header: "belz <cmd>  —  Top-level",              dir: topCommandsDir },
  ];

  const lines = [
    "NOTE FOR LLM AGENTS: Always use the --llm flag for structured, parseable output.",
    "  Example: belz ad show <uuid> --llm",
    "",
    "belz — Belzabar CLI",
  ];

  for (const { header, dir } of sections) {
    lines.push("", header, RULE);
    for (const cmd of discoverCmds(dir)) {
      const desc = await readDesc(dir, cmd);
      if (desc) { lines.push(desc, ""); }
    }
  }

  lines.push("Use 'belz <namespace> <cmd> --help' for full flag documentation and examples.");
  return lines.join("\n");
}

if (process.argv.slice(2).includes("--help-full")) {
  console.log(await buildHelpFullDynamic());
  process.exit(0);
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
