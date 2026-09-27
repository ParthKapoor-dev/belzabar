// The CLI's namespace/command wiring, shared by the entry point (bin/cli.ts)
// and tests (`@belzabar/core/testing` `loadDevCliOptions`, the envelope
// contract test). Everything comes from the static registries, so dev mode
// and the compiled binary run exactly the same command set and help text.

import {
  registryHelpResolver,
  registryModules,
  registryNames,
  type CommandRegistry,
  type NamespacedCliOptions,
} from "@belzabar/core";
import { registry as adRegistry } from "../../integrations/automation-designer/registry";
import { registry as pdRegistry } from "../../integrations/page-designer/registry";
import { registry as twRegistry } from "../../integrations/teamwork/registry";
import { registry as migrateRegistry } from "../../integrations/migrations/registry";
import { registry as releaseRegistry } from "../../integrations/release/registry";
import { registry as topCommands } from "../commands/registry";

const topRegistry: CommandRegistry = topCommands;

/** Top-level commands that own a namespace and do their own sub-routing. */
const PASSTHROUGH = {
  config: { name: "Config", description: "Manage belz credentials and environments." },
  extension: { name: "Extension", description: "Install and manage the Belzabar browser extension." },
} as const;

const NAMESPACES: Array<{ key: string; name: string; description: string; registry: CommandRegistry; header: string }> = [
  { key: "ad", name: "Automation Designer", description: "Interact with Automation Designer APIs.", registry: adRegistry, header: "belz ad <cmd>  —  Automation Designer" },
  { key: "pd", name: "Page Designer", description: "Analyze Page Designer configuration.", registry: pdRegistry, header: "belz pd <cmd>  —  Page Designer" },
  { key: "tw", name: "Teamwork", description: "Interact with the Teamwork project management API.", registry: twRegistry, header: "belz tw <cmd>  —  Teamwork" },
  { key: "migrate", name: "Migrations (Jenkins)", description: "Trigger Jenkins-backed migration builds.", registry: migrateRegistry, header: "belz migrate <cmd>  —  Migrations (Jenkins)" },
  { key: "release", name: "Release promotion tracking", description: "Audit releases: link tickets, trace items, detect collisions.", registry: releaseRegistry, header: "belz release <cmd>  —  Release promotion tracking" },
];

/** Every registry, keyed by the directory that owns its `commands/` folder (for tests). */
export const REGISTRIES: Record<string, CommandRegistry> = {
  "integrations/automation-designer": adRegistry,
  "integrations/page-designer": pdRegistry,
  "integrations/teamwork": twRegistry,
  "integrations/migrations": migrateRegistry,
  "integrations/release": releaseRegistry,
  cli: topRegistry,
};

export function buildCliOptions(): NamespacedCliOptions {
  const topHelp = registryHelpResolver(topRegistry);
  const namespaces: NamespacedCliOptions["namespaces"] = {};
  for (const ns of NAMESPACES) {
    namespaces[ns.key] = {
      name: ns.name,
      description: ns.description,
      commands: registryModules(ns.registry),
      helpResolver: registryHelpResolver(ns.registry),
    };
  }
  for (const [key, meta] of Object.entries(PASSTHROUGH)) {
    namespaces[key] = { ...meta, command: topRegistry[key]!.module, helpResolver: topHelp };
  }
  const topLevel = registryModules(topRegistry);
  for (const key of Object.keys(PASSTHROUGH)) delete topLevel[key];

  return {
    name: "Belzabar CLI",
    description: "Unified CLI for Automation Designer and Page Designer.",
    binaryName: "belz",
    namespaces,
    topLevel,
    topLevelHelpResolver: topHelp,
  };
}

/** `belz --help-full`: every command's desc.txt, sections in fixed order, commands sorted. */
export function buildHelpFull(): string {
  const RULE = "─".repeat(77);
  const lines = [
    "NOTE FOR LLM AGENTS: Always use the --llm flag for structured, parseable output.",
    "  Example: belz ad show <uuid> --llm",
    "",
    "belz — Belzabar CLI",
  ];
  const sections = [
    ...NAMESPACES.map((ns) => ({ header: ns.header, registry: ns.registry })),
    { header: "belz <cmd>  —  Top-level", registry: topRegistry },
  ];
  for (const { header, registry } of sections) {
    lines.push("", header, RULE);
    for (const name of registryNames(registry)) {
      const desc = registry[name]!.desc.trimEnd();
      if (desc) lines.push(desc, "");
    }
  }
  lines.push("Use 'belz <namespace> <cmd> --help' for full flag documentation and examples.");
  return lines.join("\n");
}
