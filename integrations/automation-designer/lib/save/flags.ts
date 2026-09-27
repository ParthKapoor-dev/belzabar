// Validator flags shared by `ad save`, `ad publish` and `ad create`.
import type { FlagsSpec } from "@belzabar/core";

export const VALIDATION_FLAGS = {
  "no-validate": { type: "boolean", description: "Skip the validator (logged loudly; not recommended)" },
  strict: { type: "boolean", description: "Treat validator warnings as errors" },
  "dry-run-compile": { type: "boolean", description: "Also run the online L4 checks (server compile dry run)" },
} as const satisfies FlagsSpec;
