// Shared types for the AD pre-save validator (lib/validate).
//
// A finding names a rule code, a severity, and a JSON path into the V2 wire
// body (`steps[2].outputs[0].fieldCode`). The path is for people; the
// fingerprint used for the diff-aware downgrade (index.ts) is derived from it
// with step indices replaced by the step's stable id.

export type Severity = "error" | "warn";

export interface StepRef {
  /** 1-based, like the AD UI and `wi-impl ad show`. */
  orderIndex: number;
  /** CUSTOM_CODE | SQL | SPEL_ECHO | REDIS_* | EXISTING_SERVICE | UNKNOWN */
  kind: string;
  /** `serviceName/methodName` when the step names one. */
  service?: string;
}

export interface ValidationFinding {
  rule: string;
  severity: Severity;
  message: string;
  path: string;
  step?: StepRef;
  fix?: string;
  /** The same finding (rule + path) is already present in `before`. */
  preexisting?: boolean;
  /** Server error text or observed runtime effect this rule prevents. */
  evidence?: string;
}

export interface ValidationResult {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  layersRun: string[];
}

/** Everything a rule needs to report one finding. */
export interface FindingInput {
  rule: string;
  message: string;
  path: string;
  /** Overrides the catalogue severity (rules with a context-dependent severity). */
  severity?: Severity;
  step?: StepRef;
  fix?: string;
  evidence?: string;
}

export type Report = (f: FindingInput) => void;

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

