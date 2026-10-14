#!/usr/bin/env bun
// The belz entry point — run directly in dev (`bun bin/cli.ts …`) and compiled
// into the release binary. Commands and help text come from the static
// registries (see bin/options.ts), so both modes behave identically.
import { flushAndExit, installStdioGuard, runNamespacedCli, trustedBelzEnv } from "@belzabar/core";
import { autoUpdateTick, recordBinaryInstall, runUpdateWorker } from "../lib/auto-update";

installStdioGuard();

// Loaded dynamically so a command module that fails to import (syntax error,
// missing export) is reported clearly on stderr instead of a bare loader trace
// or a silently missing command.
let options: typeof import("./options");
try {
  options = await import("./options");
} catch (e) {
  const err = e as Error;
  console.error(`belz: failed to load the command registry: ${err?.message ?? String(e)}`);
  if (process.env.WI_IMPL_VERBOSE === "1" && err?.stack) console.error(err.stack);
  await flushAndExit(70);
}

// Internal modes (not commands): the detached background update check, and the release
// installer recording a binary install. See lib/auto-update.ts.
const internal = trustedBelzEnv();
if (internal.WI_IMPL_UPDATE_WORKER === "1") {
  await runUpdateWorker(options!.BUILD);
  await flushAndExit(0);
}
if (internal.WI_IMPL_RECORD_INSTALL === "binary") {
  recordBinaryInstall(options!.BUILD);
  await flushAndExit(0);
}

autoUpdateTick(options!.BUILD);
await runNamespacedCli(process.argv, options!.buildCliOptions());
