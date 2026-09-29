// Validator gate shared by `ad save`, `ad publish` and `ad create`.
//
// Runs lib/validate (L1–L3, or L4 with --dry-run-compile), blocks on errors
// (and on new warnings with --strict), and turns the result into
// AD_VALIDATION_FAILED with `details = {errors, warnings, layersRun,
// preexistingCount}`. `--no-validate` skips it,
// loudly: a stderr write-log line plus a warning.

import { CliError } from "@belzabar/core";
import { logIntent } from "../args/confirm";
import type { V2MethodResponse } from "../types/v2-wire";
import { validateMethodV2, validateOnline, type ValidationFinding, type ValidationResult } from "../validate/index";

export type { ValidationFinding, ValidationResult };

type Offline = typeof validateMethodV2;
type Online = typeof validateOnline;
let offline: Offline = validateMethodV2;
let online: Online = validateOnline;
/** Tests only: substitute the validator (pass nothing to restore). */
export function __setValidatorsForTests(v: { offline?: Offline; online?: Online } = {}): void {
  offline = v.offline ?? validateMethodV2;
  online = v.online ?? validateOnline;
}

export interface ValidationFlags {
  noValidate: boolean;
  strict: boolean;
  dryRunCompile: boolean;
}

export interface ValidationSummary {
  skipped: boolean;
  warnings: ValidationFinding[];
  layersRun: string[];
}

interface GateInput {
  after: V2MethodResponse;
  before?: V2MethodResponse;
  overlayPaths?: string[];
  env: string;
  /** What is being validated, for messages ("save", "publish", "create"). */
  action: string;
  /** Extra findings to treat as blocking (e.g. publish's pre-existing errors). */
  extraBlocking?: (r: ValidationResult) => ValidationFinding[];
  warn: (msg: string) => void;
}

export async function runValidationGate(flags: ValidationFlags, input: GateInput): Promise<ValidationSummary> {
  if (flags.noValidate) {
    input.warn(`--no-validate: the ${input.action} is NOT validated. Broken methods save/publish with HTTP 200 and fail at runtime.`);
    logIntent("SKIP-VALIDATION", input.action, { reason: "--no-validate" });
    return { skipped: true, warnings: [], layersRun: [] };
  }
  const base = { after: input.after, before: input.before, overlayPaths: input.overlayPaths, strict: flags.strict };
  const result = flags.dryRunCompile
    ? await online({ ...base, env: input.env, dryRunCompile: true })
    : offline(base);

  const blocking = [...result.errors];
  // --strict: new warnings block too (lib/validate already promotes them);
  // pre-existing findings never block a save.
  if (flags.strict) blocking.push(...result.warnings.filter((w) => !w.preexisting));
  const extra = input.extraBlocking?.(result) ?? [];
  for (const f of extra) if (!blocking.includes(f)) blocking.push(f);

  if (blocking.length > 0) {
    const preexistingCount = [...result.errors, ...result.warnings].filter((f) => f.preexisting).length;
    const head = blocking
      .slice(0, 5)
      .map((f) => `${f.rule} ${f.path}: ${f.message}`)
      .join("; ");
    throw new CliError(
      `Validation blocked the ${input.action}: ${blocking.length} blocking finding(s)` +
        `${flags.strict && result.warnings.length ? " (--strict counts warnings)" : ""}. ${head}` +
        (blocking.length > 5 ? ` (+${blocking.length - 5} more)` : ""),
      {
        code: "AD_VALIDATION_FAILED",
        details: {
          errors: result.errors,
          warnings: result.warnings,
          blocking,
          layersRun: result.layersRun,
          preexistingCount,
        },
      },
    );
  }
  for (const w of result.warnings) input.warn(`${w.rule}${w.preexisting ? " (pre-existing)" : ""} ${w.path}: ${w.message}`);
  return { skipped: false, warnings: result.warnings, layersRun: result.layersRun };
}
