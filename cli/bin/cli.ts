#!/usr/bin/env bun
import { flushAndExit, installStdioGuard, runNamespacedCli } from "@belzabar/core";
import { buildDevCliOptions, buildHelpFullDynamic } from "./dev-commands";

// Dev Mode: commands are discovered dynamically (see dev-commands.ts).
if (process.argv.slice(2).includes("--help-full")) {
  installStdioGuard(); // flush before exiting, or a piped --help-full is truncated past the pipe buffer
  console.log(await buildHelpFullDynamic());
  await flushAndExit(0);
}

await runNamespacedCli(process.argv, buildDevCliOptions());
