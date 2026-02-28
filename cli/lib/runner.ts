import { runCli as baseRunCli, runNamespacedCli } from "@belzabar/core";
import type { NamespacedCliOptions } from "@belzabar/core";

// Backward-compat: thin wrapper used by the old single-namespace CLI
export async function runCli(
  argv: string[],
  commandMap: Record<string, any>,
  helpResolver?: (cmd: string) => Promise<string | null>
) {
  return baseRunCli(argv, commandMap, {
    name: "Automation Designer CLI",
    description: "A Bun + TypeScript CLI for interacting with Automation Designer APIs.",
    binaryName: "belz",
  }, helpResolver);
}

// New: unified belz runner with AD + PD namespaces
export async function runBelzCli(
  argv: string[],
  adCommands: Record<string, any>,
  pdCommands: Record<string, any>,
  topLevelCommands: Record<string, any>,
  helpDirs?: { ad?: string; pd?: string; top?: string }
) {
  return runNamespacedCli(argv, {
    name: "Belzabar CLI",
    description: "Unified CLI for Automation Designer and Page Designer.",
    binaryName: "belz",
    namespaces: {
      ad: {
        name: "Automation Designer",
        description: "Interact with Automation Designer APIs.",
        commands: adCommands,
        helpDir: helpDirs?.ad,
      },
      pd: {
        name: "Page Designer",
        description: "Analyze Page Designer configuration.",
        commands: pdCommands,
        helpDir: helpDirs?.pd,
      },
    },
    topLevel: topLevelCommands,
    topLevelHelpDir: helpDirs?.top,
  } satisfies NamespacedCliOptions);
}
