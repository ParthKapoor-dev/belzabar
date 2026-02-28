import { ADCommandRegistry } from "../commands/registry-ad";
import { PDCommandRegistry } from "../commands/registry-pd";
import { TopLevelCommandRegistry } from "../commands/registry-top";
import { ADHelpMap, PDHelpMap, TopHelpMap, makeHelpResolver } from "../commands/registry-help";
import { runNamespacedCli } from "@belzabar/core";

const { migrate, ...topLevelCommands } = TopLevelCommandRegistry;
const topHelpResolver = makeHelpResolver(TopHelpMap);

// Prod Mode: Use generated registries + embedded help text (bundled at compile time)
await runNamespacedCli(process.argv, {
  name: "Belzabar CLI",
  description: "Unified CLI for Automation Designer and Page Designer.",
  binaryName: "belz",
  namespaces: {
    ad: {
      name: "Automation Designer",
      description: "Interact with Automation Designer APIs.",
      commands: ADCommandRegistry,
      helpResolver: makeHelpResolver(ADHelpMap),
    },
    pd: {
      name: "Page Designer",
      description: "Analyze Page Designer configuration.",
      commands: PDCommandRegistry,
      helpResolver: makeHelpResolver(PDHelpMap),
    },
    migrate: {
      name: "Migrations",
      description: "Run NSM database migrations.",
      command: migrate,
      helpResolver: topHelpResolver,
    },
  },
  topLevel: topLevelCommands,
  topLevelHelpResolver: topHelpResolver,
});
