// Flag fragments shared by AD commands, as core `defineArgs` spec pieces.
// `--env` and `--llm` are handled by the runner.

import type { FlagsSpec } from "@belzabar/core";
import type { ApiVersion } from "../types/common";

/** `--v2`: read the method through the V2 API (commands that fetch a method). */
export const AD_V2_FLAG = {
  v2: { type: "boolean", description: "Fetch through the V2 API" },
} as const satisfies FlagsSpec;

/** The API version a command selected with `--v2` (V1 by default). */
export function apiVersionOf(flags: { v2: boolean }): ApiVersion {
  return flags.v2 ? "v2" : "v1";
}

/** `--yes`: skip the confirmation prompt (required in --llm mode on writes). */
export const AD_YES_FLAG = {
  yes: { type: "boolean", alias: ["-y"] },
} as const satisfies FlagsSpec;

/** `--note "<text>"`: a change note recorded in the method's changelog. */
export const AD_NOTE_FLAG = {
  note: { type: "string" },
} as const satisfies FlagsSpec;
