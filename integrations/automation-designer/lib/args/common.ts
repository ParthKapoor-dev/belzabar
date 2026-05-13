// Shared argument parser for every AD command.
//
// Strips belz's common AD flags out of argv and hands back the remainder for
// the command's own parser to chew on. Today that means only --v2 (the API
// version selector), but this is the file to add cross-command flags to.
//
// Every AD command calls parseAdCommonArgs(argv, op, cmdName) at the top of
// its parseArgs(). The returned `rest` is the argv with --v2 removed. The
// returned `apiVersion` is a ResolvedVersion — if the user asked for --v2 on
// an op that does not support V2 the resolver sets wasFallback=true and the
// command (via emitFallbackWarning) prints a one-line notice before running
// V1. Commands never read DEFAULT_VERSION directly.

import { resolveApiVersion, type AdOperation, type ResolvedVersion } from "../api-version";

export interface AdCommonArgs {
  apiVersion: ResolvedVersion;
}

export interface ParsedAdArgs {
  common: AdCommonArgs;
  rest: string[];
}

/**
 * Strip AD common flags from argv. `--v2` is consumed here. `--env`, `--llm`,
 * `-v/--verbose` are handled upstream in packages/core/runner.ts so they are
 * NOT in argv by the time this runs.
 */
export function parseAdCommonArgs(
  argv: string[],
  op: AdOperation,
  _cmdName: string,
): ParsedAdArgs {
  const rest: string[] = [];
  let wantsV2 = false;

  for (const arg of argv) {
    if (arg === "--v2") {
      wantsV2 = true;
      continue;
    }
    rest.push(arg);
  }

  const apiVersion = resolveApiVersion(op, wantsV2 ? "v2" : undefined);
  return { common: { apiVersion }, rest };
}

// Deduplication set for warn-once behaviour within a single CLI invocation.
const warnedKeys = new Set<string>();

/**
 * If the resolver marked the version as a fallback, emit a single, de-duped
 * warning to stderr so the user knows their --v2 was ignored for this command.
 * No-op when wasFallback is false.
 */
export function emitFallbackWarning(common: AdCommonArgs, cmdName: string): void {
  if (!common.apiVersion.wasFallback) return;
  const key = `ad-v2-fallback:${cmdName}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  process.stderr.write(
    `⚠️  V2 not supported for 'belz ad ${cmdName}' — using V1.\n`,
  );
}

// Exposed for tests. Production code should never call this.
export function __resetWarnOnceForTests(): void {
  warnedKeys.clear();
}
