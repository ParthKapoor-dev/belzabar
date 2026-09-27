// HTTP response → CliError mapping, shared by every integration.
//
//   const res = await apiFetch(path);
//   const body = await expectJson<T>(res, { path, notFoundCode: "METHOD_NOT_FOUND" });
//
// - 404                → NOT_FOUND (or the caller's notFoundCode)
// - other 4xx/5xx      → HTTP_<status> (or `${codePrefix}_<status>`)
// - 200 + empty/"null" → not-found (the AD chain endpoints answer an unknown
//                        uuid with 200 and an empty body; AD-11 / F10)
// Bodies are summarised before they reach a message or error.details: HTML is
// reduced to its <title>, everything is truncated and secret-redacted.

import { CliError } from "../command";
import { redactSecrets, redactString } from "./redact";

export const MAX_ERROR_BODY_CHARS = 500;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function looksLikeHtml(text: string, contentType?: string | null): boolean {
  if (contentType && /html/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text);
}

/**
 * Reduce a response body to something safe to print: HTML → its <title> (or
 * "HTML page"), whitespace collapsed, truncated to `max` chars, secrets redacted.
 */
export function summarizeBody(text: string, contentType?: string | null, max = MAX_ERROR_BODY_CHARS): string {
  let out = text ?? "";
  if (looksLikeHtml(out, contentType)) {
    const title = out.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    out = title ? `HTML page: ${decodeEntities(title).replace(/\s+/g, " ").trim()}` : "HTML page (no title)";
  }
  out = redactString(out.trim());
  if (out.length > max) out = `${out.slice(0, max)}… (${out.length - max} more chars)`;
  return out;
}

/** Read a response body as a summary (never throws). */
export async function readBodySummary(res: Response, max = MAX_ERROR_BODY_CHARS): Promise<string> {
  try {
    return summarizeBody(await res.text(), res.headers.get("content-type"), max);
  } catch {
    return "(response body unreadable)";
  }
}

/**
 * Error-details form of a body: small JSON bodies stay structured (redacted) so
 * agents can read server messages; anything else becomes a summary string.
 */
export async function readErrorBody(res: Response, maxJsonChars = 4096): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return "(response body unreadable)";
  }
  if (text.length <= maxJsonChars) {
    try {
      return redactSecrets(JSON.parse(text));
    } catch {
      /* not JSON */
    }
  }
  return summarizeBody(text, res.headers.get("content-type"));
}

export interface HttpErrorOptions {
  /** Path or label for the message (e.g. `/rest/api/automation/chain/x`). Query strings are kept. */
  path?: string;
  method?: string;
  /** Code prefix for non-404 errors: `${prefix}_${status}`. Default "HTTP". */
  codePrefix?: string;
  /** Code for 404. Default "NOT_FOUND" (or `${codePrefix}_NOT_FOUND` when a prefix is given). */
  notFoundCode?: string;
  /** Message for 404. */
  notFoundMessage?: string;
  /** Override the message head (the status + summary are appended). */
  message?: string;
  /** Extra fields for error.details (redacted). */
  details?: Record<string, unknown>;
}

/** Build the CliError for a non-OK response (consumes the body). */
export async function httpError(res: Response, opts: HttpErrorOptions = {}): Promise<CliError> {
  const body = await readBodySummary(res);
  const path = opts.path === undefined ? undefined : redactString(opts.path);
  const where = path ? ` on ${opts.method ? `${opts.method.toUpperCase()} ` : ""}${path}` : "";
  const statusText = res.statusText ? ` ${res.statusText}` : "";
  const details = redactSecrets({ ...(opts.details ?? {}), status: res.status, path: opts.path, body });
  if (res.status === 404) {
    const code = opts.notFoundCode ?? (opts.codePrefix ? `${opts.codePrefix}_NOT_FOUND` : "NOT_FOUND");
    const message = opts.notFoundMessage ?? `${opts.message ?? "Not found"}${where} (HTTP 404)`;
    return new CliError(message, { code, details });
  }
  const code = `${opts.codePrefix ?? "HTTP"}_${res.status}`;
  const head = opts.message ?? `HTTP ${res.status}${statusText}${where}`;
  const tail = opts.message ? ` (HTTP ${res.status})` : "";
  return new CliError(`${head}${tail}${body ? `: ${body}` : ""}`, { code, details });
}

/** Throw the mapped CliError unless `res.ok`. */
export async function expectOk(res: Response, opts: HttpErrorOptions = {}): Promise<Response> {
  if (res.ok) return res;
  throw await httpError(res, opts);
}

export interface ExpectJsonOptions extends HttpErrorOptions {
  /**
   * When true (the default for expectJson), a 2xx with an empty body or a
   * literal `null` is treated as not-found (`notFoundCode`). Set false to get
   * `null` back instead.
   */
  emptyIsNotFound?: boolean;
}

/**
 * Parse a JSON response. Non-OK → mapped CliError; 2xx with empty/`null` body →
 * not-found CliError (AD-11); unparseable JSON → HTTP_BAD_JSON.
 */
export async function expectJson<T>(res: Response, opts: ExpectJsonOptions = {}): Promise<T> {
  const value = await readJsonOrNull<T>(res, opts);
  if (value === null && opts.emptyIsNotFound !== false) {
    throw notFoundError(opts);
  }
  return value as T;
}

/** Like expectJson, but an empty/`null` 2xx body (or a 404) resolves to `null`. */
export async function readJsonOrNull<T>(res: Response, opts: HttpErrorOptions = {}): Promise<T | null> {
  if (!res.ok) {
    if (res.status === 404 && (opts as ExpectJsonOptions).emptyIsNotFound === false) return null;
    throw await httpError(res, opts);
  }
  const text = await res.text();
  if (text.trim() === "" || text.trim() === "null") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(
      `Expected JSON${opts.path ? ` from ${redactString(opts.path)}` : ""} but got: ${summarizeBody(text, res.headers.get("content-type"), 200)}`,
      { code: "HTTP_BAD_JSON", details: redactSecrets({ status: res.status, path: opts.path }) },
    );
  }
}

function notFoundError(opts: HttpErrorOptions): CliError {
  const code = opts.notFoundCode ?? (opts.codePrefix ? `${opts.codePrefix}_NOT_FOUND` : "NOT_FOUND");
  const message = opts.notFoundMessage ?? `Not found${opts.path ? `: ${redactString(opts.path)}` : ""} (empty response)`;
  return new CliError(message, { code, details: redactSecrets({ path: opts.path, ...(opts.details ?? {}) }) });
}

/** Throw a not-found CliError when `value` is null/undefined; otherwise return it. */
export function expectFound<T>(value: T | null | undefined, opts: HttpErrorOptions = {}): T {
  if (value === null || value === undefined) throw notFoundError(opts);
  return value;
}
