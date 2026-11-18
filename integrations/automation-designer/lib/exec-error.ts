// The failure answer of a method execution (`ad run`: /chain/execute; `ad test`: a
// non-2xx /chain/test) reduced to what the method itself said.
//
// The server wraps a step's error in layers of JSON text: the body may be JSON text
// of JSON text, and its `message` is often the JSON text of `{status, status_message,
// error}` (custom code) or `{result: {message}}`. `decodeJsonText` parses every layer,
// `executionFailure` picks the failing step, its HTTP status and its message, and
// `executionError` builds the CliError: the method's message goes in error.message,
// the decoded body in details.body. A body longer than INLINE_BODY_CHARS is not put
// in the envelope (it used to be cut there): it is written whole, redacted, to
// ~/.wi-impl/logs/errors/ and details.bodyFile names the file.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR, CliError, isObj, redactSecrets, redactString, summarizeBody } from "@belzabar/core";

/** Bodies up to this size go into error.details whole; larger ones go to a file. */
const INLINE_BODY_CHARS = 16_384;
const MESSAGE_CHARS = 300;

interface ExecutionFailure {
  /** HTTP status the method answered with (the step's exit code), else the response status. */
  status: number | null;
  /** Failing step (orderIndex), when the body names it. */
  step: number | null;
  /** The method's own message: the first line of the innermost error text. */
  message: string | null;
}

/** Parse JSON text (also JSON text inside JSON text, and inside objects and lists) into values. */
export function decodeJsonText(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    const t = value.trim();
    if (depth >= 4 || !(t.startsWith("{") || t.startsWith("[") || t.startsWith('"'))) return value;
    try {
      return decodeJsonText(JSON.parse(t), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((v) => decodeJsonText(v, depth));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeJsonText(v, depth)]));
  return value;
}

function firstLine(text: string): string | null {
  const line = text.trim().split("\n")[0]!.trim();
  if (!line) return null;
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS)}…` : line;
}

/** The innermost error text of a (decoded) error value. */
function errorText(value: unknown): string | null {
  if (typeof value === "string") return firstLine(value);
  if (!isObj(value)) return null;
  if (isObj(value.result)) {
    const inner = errorText(value.result.databaseError ?? value.result.message);
    if (inner) return inner;
  }
  for (const k of ["error", "databaseError", "errorMessage", "message", "detail", "status_message"]) {
    const t = errorText(value[k]);
    if (t) return t;
  }
  return null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Failing step, status and message of a decoded execution body. */
export function executionFailure(body: unknown, httpStatus: number | null = null): ExecutionFailure {
  if (!isObj(body)) return { status: httpStatus, step: null, message: errorText(body) };
  const statuses = Array.isArray(body.failingStepsStatuses) ? body.failingStepsStatuses.filter(isObj) : [];
  const first = statuses[0];
  const steps = Array.isArray(body.failingSteps) ? body.failingSteps : [];
  const step = num(first?.stepIndex) ?? num(steps[0]);
  const status = num(first?.statusCode) ?? num(body.statusCode) ?? httpStatus;
  const message = (first ? errorText(first.errorMessage) ?? errorText(first.message) : null) ?? errorText(body);
  return { status, step, message };
}

/** `Execution failed (500) at step 9: <message>` */
function failureMessage(label: string, f: ExecutionFailure): string {
  const status = f.status != null ? ` (${f.status})` : "";
  const step = f.step != null ? ` at step ${f.step}` : "";
  return `${label}${status}${step}${f.message ? `: ${f.message}` : ""}`;
}

/** Write a long error body whole (redacted) under ~/.wi-impl/logs/errors/; null when it cannot be written. */
function saveErrorBody(text: string, decoded: unknown, tag: string): string | null {
  try {
    const dir = join(BELZ_CONFIG_DIR, "logs", "errors");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.json`);
    const content = typeof decoded === "string" ? redactString(text) : JSON.stringify(redactSecrets(decoded), null, 2);
    writeFileSync(file, content, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

interface ExecutionErrorOptions {
  code: string;
  /** Message head: `Execution failed`. */
  label: string;
  /** Request path, for details.path. */
  path?: string;
  /** File-name tag for a saved long body. */
  tag: string;
}

/**
 * The CliError for a non-2xx execution answer (consumes the body): error.message
 * names the status, the failing step and the method's own message; details are
 * {path?, status, body, step?, methodMessage?, methodStatus?, bodyFile?}.
 */
export async function executionError(res: Response, opts: ExecutionErrorOptions): Promise<CliError> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  const decoded = decodeJsonText(text);
  const failure = executionFailure(decoded, res.status);
  const details: Record<string, unknown> = opts.path === undefined ? {} : { path: opts.path };
  details.status = res.status;
  if (text.length <= INLINE_BODY_CHARS) {
    details.body = redactSecrets(decoded);
  } else {
    details.body = summarizeBody(text, res.headers.get("content-type"));
    const file = saveErrorBody(text, decoded, opts.tag);
    if (file) details.bodyFile = file;
  }
  if (failure.step != null) details.step = failure.step;
  if (failure.message) details.methodMessage = redactString(failure.message);
  if (failure.status != null && failure.status !== res.status) details.methodStatus = failure.status;
  const where = details.bodyFile ? ` (whole body: ${details.bodyFile})` : "";
  const message = failureMessage(opts.label, { ...failure, status: res.status, message: failure.message && redactString(failure.message) });
  return new CliError(`${message}${where}`, { code: opts.code, details });
}
