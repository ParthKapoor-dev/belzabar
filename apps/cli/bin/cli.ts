#!/usr/bin/env bun
// The belz entry point — run directly in dev (`bun bin/cli.ts …`) and compiled
// into the release binary. Commands and help text come from the static
// registries (see bin/options.ts), so both modes behave identically.
import { flushAndExit, installStdioGuard, runNamespacedCli } from "@belzabar/core";
import { buildCliOptions, buildHelpFull } from "./options";

if (process.argv.slice(2).includes("--help-full")) {
  installStdioGuard(); // flush before exiting, or a piped --help-full is truncated past the pipe buffer
  console.log(buildHelpFull());
  await flushAndExit(0);
}

await runNamespacedCli(process.argv, buildCliOptions());
