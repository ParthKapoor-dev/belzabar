// Flags shared by PD commands, as core `defineArgs` spec fragments.
//
//   export const args = defineArgs({
//     command: "wi-impl pd save",
//     positionals: [{ name: "page-id", required: true }],
//     flags: { ...PD_WRITE_OVERRIDE_FLAGS, ...PD_YES_FLAG, ...PD_DRY_RUN_FLAG, overlay: { type: "string" } },
//   });
//
// Spread a fragment only where the flag means something: read commands do not
// take --yes. `--env` and `--llm` are handled by the runner.

import type { FlagsSpec } from "@belzabar/core";

/** `--force` on READ commands: bypass the local config cache. */
export const PD_FORCE_FLAG = {
  force: { type: "boolean" },
} as const satisfies FlagsSpec;

/**
 * Write-command guard overrides:
 *   --force-validation   proceed despite validator ERRORS (listed in bypassedErrors)
 *   --allow-published    write/publish a PUBLISHED page with no linked draft
 */
export const PD_WRITE_OVERRIDE_FLAGS = {
  "force-validation": { type: "boolean" },
  "allow-published": { type: "boolean" },
} as const satisfies FlagsSpec;

export interface WriteOverrides {
  forceValidation: boolean;
  allowPublished: boolean;
}

/** `--yes` / `-y`: skip the confirmation prompt (required in --llm mode on writes). */
export const PD_YES_FLAG = {
  yes: { type: "boolean", alias: ["-y"] },
} as const satisfies FlagsSpec;

/** `--dry-run`: run the whole flow but skip the network write. */
export const PD_DRY_RUN_FLAG = {
  "dry-run": { type: "boolean" },
} as const satisfies FlagsSpec;

/** `--status PUBLISHED|DRAFT` for the page-dependencies API. */
export const PD_DEP_STATUS_FLAG = {
  status: { type: "enum", values: ["PUBLISHED", "DRAFT"], default: "PUBLISHED" },
} as const satisfies FlagsSpec;

/** Positional `<input>`: a page/component id, name, or URL. */
export const PD_INPUT_POSITIONAL = {
  name: "input",
  required: true,
  missingCode: "MISSING_INPUT",
  missingMessage: "Missing <input>. Provide a PD page/component id, name, or URL.",
} as const;
