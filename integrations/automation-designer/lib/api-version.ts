// Automation Designer API version core.
//
// belz-cli speaks two AD API surfaces: V1 (current default, what the UI uses,
// supports test-before-save with rich JSON trace) and V2 (newer, flat JSON,
// portable UUIDs, required for clean programmatic construction, returns XML
// for test executions). This file is the single source of truth for which
// version every AD operation uses by default and which versions belz actually
// implements for each operation.
//
// To flip the default for a specific operation, edit DEFAULT_VERSION below.
// To flip the whole CLI to V2-default, change every "v1" in DEFAULT_VERSION.
// To add V2 support to a new operation:
//   1. Add "v2" to SUPPORTED_VERSIONS[op].
//   2. Add the verb to lib/api/v2.ts.
//   3. Update the dispatcher in lib/api/index.ts.
// See docs/api-notes.md for the long-form rationale.

export type ApiVersion = "v1" | "v2";

export type AdOperation =
  | "fetch"      // GET a method definition
  | "list"       // list methods in a category
  | "save"       // create or update a method
  | "publish"    // promote a draft to published
  | "test"       // test-execute a method
  | "run"        // live-execute a published method
  | "export"     // export method or category JSON
  | "import"     // import method JSON
  | "testCase"   // test-case CRUD + suite
  | "category"   // list / create category
  | "childInfo"; // fetch metadata for a method called as a step

// The version used when the caller does NOT pass --v2. Flip a cell to change
// the default for that operation.
export const DEFAULT_VERSION: Record<AdOperation, ApiVersion> = {
  fetch:     "v1",
  list:      "v1",
  save:      "v1",
  publish:   "v1",
  test:      "v1",
  run:       "v1",
  export:    "v1",
  import:    "v1",
  testCase:  "v1",
  category:  "v1",
  childInfo: "v1",
};

// Which versions belz actually implements for each operation. If the user
// asks for --v2 on an operation whose supported set does not include "v2",
// resolveApiVersion() falls back to the DEFAULT_VERSION and marks
// wasFallback=true so callers can emit a one-line notice.
export const SUPPORTED_VERSIONS: Record<AdOperation, readonly ApiVersion[]> = {
  fetch:     ["v1", "v2"],
  list:      ["v1"],
  save:      ["v1"],
  publish:   ["v1"],         // publish is a shared endpoint; nothing to split
  test:      ["v1", "v2"],
  run:       ["v1"],
  export:    ["v1"],
  import:    ["v1"],
  testCase:  ["v1"],
  category:  ["v1"],
  childInfo: ["v1"],
};

export class UnsupportedVersionError extends Error {
  constructor(public readonly op: AdOperation, public readonly requested: ApiVersion) {
    super(`Version ${requested} not supported for operation ${op}`);
    this.name = "UnsupportedVersionError";
  }
}

export interface ResolvedVersion {
  /** The version the command should actually execute against. */
  version: ApiVersion;
  /** True when the caller asked for a version we do not support and we fell back. */
  wasFallback: boolean;
  /** The version the caller requested (or the default if none was requested). */
  requested: ApiVersion;
}

/**
 * Resolve the API version to use for an operation.
 *
 * Precedence:
 *   1. Explicit --v2 request (argument `requested`)
 *   2. DEFAULT_VERSION[op]
 *
 * If the resolved version is not in SUPPORTED_VERSIONS[op], fall back to
 * DEFAULT_VERSION[op] and mark wasFallback=true. If the default itself is
 * not supported (a programming error in this file), throws
 * UnsupportedVersionError so the misconfiguration is caught in tests.
 */
export function resolveApiVersion(
  op: AdOperation,
  requested: ApiVersion | undefined,
): ResolvedVersion {
  const effectiveRequested: ApiVersion = requested ?? DEFAULT_VERSION[op];
  const supported = SUPPORTED_VERSIONS[op];

  if (supported.includes(effectiveRequested)) {
    return { version: effectiveRequested, wasFallback: false, requested: effectiveRequested };
  }

  const fallback = DEFAULT_VERSION[op];
  if (!supported.includes(fallback)) {
    // DEFAULT_VERSION[op] must always be in SUPPORTED_VERSIONS[op]; if this
    // throws, it is a bug in the tables above.
    throw new UnsupportedVersionError(op, fallback);
  }

  return { version: fallback, wasFallback: true, requested: effectiveRequested };
}
