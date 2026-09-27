// Flags shared by every AD command, as core `defineArgs` spec fragments.
//
//   export const args = defineArgs({
//     command: "belz ad show",
//     positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID" }],
//     flags: { ...AD_COMMON_FLAGS, full: { type: "boolean" } },
//   });
//   const { flags } = args.parse(argv);
//   const common = resolveAdCommon(flags, "fetch", "show");   // → { apiVersion }
//
// Every AD command accepts `--v2` (AD-37). If the op has no V2 implementation the
// resolver falls back to V1 and `resolveAdCommon` prints a one-line notice.
// `--env`, `--llm` are handled by the runner.

import type { FlagsSpec } from "@belzabar/core";
import { resolveApiVersion, type AdOperation, type ResolvedVersion } from "../api-version";

export const AD_COMMON_FLAGS = {
  v2: { type: "boolean", description: "Use the V2 API (falls back to V1 with a notice where unsupported)" },
} as const satisfies FlagsSpec;

/** `--yes`: skip the confirmation prompt (required in --llm mode on writes). */
export const AD_YES_FLAG = {
  yes: { type: "boolean", alias: ["-y"] },
} as const satisfies FlagsSpec;

/** `--note "<text>"`: a change note recorded in the method's changelog. */
export const AD_NOTE_FLAG = {
  note: { type: "string" },
} as const satisfies FlagsSpec;

export interface AdCommonArgs {
  apiVersion: ResolvedVersion;
}

/** Resolve the API version from the parsed common flags; warns once on a V2→V1 fallback. */
export function resolveAdCommon(flags: { v2: boolean }, op: AdOperation, cmdName: string): AdCommonArgs {
  const common = { apiVersion: resolveApiVersion(op, flags.v2 ? "v2" : undefined) };
  emitFallbackWarning(common, cmdName);
  return common;
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
  process.stderr.write(`⚠️  V2 not supported for 'belz ad ${cmdName}' — using V1.\n`);
}

// Exposed for tests. Production code should never call this.
export function __resetWarnOnceForTests(): void {
  warnedKeys.clear();
}
