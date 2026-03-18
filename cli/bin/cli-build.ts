import { ADCommandRegistry } from "../commands/registry-ad";
import { PDCommandRegistry } from "../commands/registry-pd";
import { TopLevelCommandRegistry } from "../commands/registry-top";
import { ADHelpMap, PDHelpMap, TopHelpMap, makeHelpResolver, HELP_FULL_TEXT } from "../commands/registry-help";
import { runNamespacedCli } from "@belzabar/core";

if (process.argv.slice(2).includes("--help-full")) {
  console.log(HELP_FULL_TEXT);
  process.exit(0);
}

const { migrate, config, web, ...topLevelCommands } = TopLevelCommandRegistry;
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
    config: {
      name: "Config",
      description: "Manage belz credentials and environments.",
      command: config,
      helpResolver: topHelpResolver,
    },
    web: {
      name: "Web",
      description: "Manage the Belzabar web app.",
      command: web,
      helpResolver: topHelpResolver,
    },
  },
  topLevel: topLevelCommands,
  topLevelHelpResolver: topHelpResolver,
});
