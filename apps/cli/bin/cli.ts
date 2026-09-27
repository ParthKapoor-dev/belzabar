#!/usr/bin/env bun
// The belz entry point — run directly in dev (`bun bin/cli.ts …`) and compiled
// into the release binary. Commands and help text come from the static
// registries (see bin/options.ts), so both modes behave identically.
import { flushAndExit, installStdioGuard, runNamespacedCli } from "@belzabar/core";

installStdioGuard();

// Loaded dynamically so a command module that fails to import (syntax error,
// missing export) is reported clearly on stderr instead of a bare loader trace
// or a silently missing command (CORE-22).
let options: typeof import("./options");
try {
  options = await import("./options");
} catch (e) {
  const err = e as Error;
  console.error(`belz: failed to load the command registry: ${err?.message ?? String(e)}`);
  if (process.env.BELZ_VERBOSE === "1" && err?.stack) console.error(err.stack);
  await flushAndExit(70);
}

if (process.argv.slice(2).includes("--help-full")) {
  console.log(options!.buildHelpFull());
  await flushAndExit(0);
}

await runNamespacedCli(process.argv, options!.buildCliOptions());
