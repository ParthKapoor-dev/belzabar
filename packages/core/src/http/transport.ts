// The one transport every belz HTTP call goes through (AD/PD via apiFetch,
// Teamwork, Jenkins):
//   - IPv4 pinning (dns.ts) with pin eviction + one hostname retry when the
//     pinned IP fails to connect (CORE-20). The retry happens only for
//     connect-phase failures (nothing was sent) or for read methods; a POST
//     whose connection dropped after it may have been sent is never re-sent
//     (CORE-R1);
//   - a default timeout mapped to CliError HTTP_TIMEOUT instead of hanging
//     forever (CORE-13): 60 s for GET/HEAD, 300 s for anything else (AD test,
//     run, SQL, save/publish execute server-side and are legitimately slow).
//     Per call `timeoutMs` (0 / "none" disables); env BELZ_HTTP_TIMEOUT_MS
//     (both defaults) and BELZ_HTTP_WRITE_TIMEOUT_MS (non-GET only). A timed-out
//     non-GET is never retried and says it may still complete server-side.
//     The same limit is an idle deadline on the body read (CORE-R10);
//   - network failures mapped to CliError HTTP_NETWORK_ERROR (never an
//     UNHANDLED_EXCEPTION);
//   - verbose logging with secrets redacted.

import { CliError } from "../command";
import { vlog, vtime } from "../verbose";
import { trustedBelzEnv } from "../config/env-vars";
import { evictIpv4Cache, prepareIpv4Fetch } from "./dns";
import { redactString } from "./redact";

/** Default timeout for GET/HEAD (ms). */
export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
/** Default timeout for every other method (ms): the server executes work (tests, SQL, publish). */
export const DEFAULT_HTTP_WRITE_TIMEOUT_MS = 300_000;

/** Per-call timeout: ms to wait for response headers; `0` or `"none"` disables it (streaming, long ops). */
type TimeoutOption = number | "none";

export interface HttpInit extends RequestInit {
  /**
   * Abort after this many ms waiting for response headers. `0` / `"none"` disables.
   * Default: 60 s for GET/HEAD, 300 s otherwise (see defaultTimeoutMs).
   */
  timeoutMs?: TimeoutOption;
  /** Pin the request to the host's IPv4 address (default true). */
  pinIpv4?: boolean;
}

function envMs(name: string): number | undefined {
  const raw = trustedBelzEnv()[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** True for methods that only read (the server has nothing to "complete" after a timeout). */
function isReadMethod(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/**
 * The default timeout for `method`: BELZ_HTTP_WRITE_TIMEOUT_MS (non-GET only)
 * > BELZ_HTTP_TIMEOUT_MS (all methods) > 60 s GET / 300 s otherwise.
 */
export function defaultTimeoutMs(method: string = "GET"): number {
  if (isReadMethod(method)) return envMs("BELZ_HTTP_TIMEOUT_MS") ?? DEFAULT_HTTP_TIMEOUT_MS;
  return envMs("BELZ_HTTP_WRITE_TIMEOUT_MS") ?? envMs("BELZ_HTTP_TIMEOUT_MS") ?? DEFAULT_HTTP_WRITE_TIMEOUT_MS;
}

/** Resolve a per-call option to ms (0 = no timeout). */
export function resolveTimeoutMs(option: TimeoutOption | undefined, method: string = "GET"): number {
  if (option === "none") return 0;
  if (option === undefined) return defaultTimeoutMs(method);
  return Number.isFinite(option) && option > 0 ? option : 0;
}

/** URL safe for logs/messages: query values that look secret are redacted. */
function safeUrl(url: string): string {
  return redactString(url);
}

/**
 * Error codes/messages that mean the TCP connection was never established, so
 * no request bytes reached the server and re-sending any method is safe.
 * Bun reports a refused connect as code "ConnectionRefused" ("Unable to connect…").
 */
const CONNECT_PHASE_CODES = [
  "ECONNREFUSED",
  "ConnectionRefused",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "FailedToOpenSocket",
  "ENOTFOUND",
  "EAI_AGAIN",
];
const CONNECT_PHASE_RE = new RegExp(`\\b(${CONNECT_PHASE_CODES.join("|")})\\b|Unable to connect`, "i");

/** True when `err` is a failure to connect (no bytes sent). ECONNRESET / "socket closed" are not. */
export function isConnectPhaseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return CONNECT_PHASE_RE.test(String(err));
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CONNECT_PHASE_CODES.some((c) => c.toLowerCase() === code.toLowerCase())) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && CONNECT_PHASE_RE.test(message);
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === "object" && ((err as any).name === "AbortError" || (err as any).name === "TimeoutError");
}

async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  method: string,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let timedOut = false;
  let rejectTimeout: (e: unknown) => void = () => {};
  // Raced against fetch so even a fetch that ignores the signal cannot hang us.
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("timeout"));
          rejectTimeout(new Error("timeout"));
        }, timeoutMs)
      : null;

  const stop = vtime(label);
  try {
    const res = await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeoutPromise]);
    stop();
    return timeoutMs > 0 ? withBodyDeadline(res, timeoutMs, controller, () => bodyTimeoutError(timeoutMs, label, method)) : res;
  } catch (err) {
    stop();
    if (timedOut) throw timeoutError(timeoutMs, label, method);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Statuses whose Response must have a null body (the constructor throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Keep a deadline on the body read (CORE-R10): the header timeout alone let a
 * server that stalls mid-body hang `res.text()` / `res.json()` forever. Each
 * read of the underlying stream must produce a chunk within `timeoutMs` (an
 * idle timeout, so a large but steadily flowing body is fine); otherwise the
 * fetch is aborted and the body read rejects with HTTP_TIMEOUT. No timer runs
 * while nobody is reading the body.
 */
function withBodyDeadline(
  res: Response,
  timeoutMs: number,
  controller: AbortController,
  makeError: () => CliError,
): Response {
  if (!res.body || NULL_BODY_STATUSES.has(res.status)) return res;
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = makeError();
          // Reject first: cancelling resolves the pending read with done:true,
          // which would otherwise win the race and end the body "successfully".
          reject(err);
          controller.abort(err);
          reader.cancel(err).catch(() => {});
        }, timeoutMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      } catch (err) {
        ctrl.error(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const wrapped = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  // Keep the metadata a constructed Response loses.
  Object.defineProperty(wrapped, "url", { value: res.url });
  Object.defineProperty(wrapped, "redirected", { value: res.redirected });
  return wrapped;
}

function bodyTimeoutError(timeoutMs: number, label: string, method: string): CliError {
  const secs = Math.round(timeoutMs / 1000);
  return new CliError(`Response body stalled for ${secs}s: ${label}.`, {
    code: "HTTP_TIMEOUT",
    details: { timeoutMs, method, phase: "body", mayHaveCompleted: !isReadMethod(method), retryable: isReadMethod(method) },
  });
}

/**
 * fetch() with the belz transport policy. Resolves with any HTTP status (use
 * errors.ts to map non-OK responses); rejects only with CliError
 * (HTTP_TIMEOUT / HTTP_NETWORK_ERROR / HTTP_ABORTED).
 */
export async function httpRequest(url: string, init: HttpInit = {}): Promise<Response> {
  const { timeoutMs: t, pinIpv4 = true, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const timeoutMs = resolveTimeoutMs(t, method);
  const label = `HTTP ${method} ${safeUrl(url)}`;

  const prepared = pinIpv4 ? await prepareIpv4Fetch(url, rest) : { url, init: rest as RequestInit, pinnedHost: undefined };

  let response: Response;
  try {
    response = await fetchOnce(prepared.url, prepared.init, timeoutMs, label, method);
  } catch (err) {
    // CliError here = HTTP_TIMEOUT: never retried (a non-GET may still be running server-side).
    if (err instanceof CliError) throw err;
    if (isAbortError(err)) {
      throw new CliError(`Request aborted: ${label}`, { code: "HTTP_ABORTED" });
    }
    const connectPhase = isConnectPhaseError(err);
    if (!prepared.pinnedHost) throw networkError(err, label, method, connectPhase);
    // The pinned IP may be stale (load balancer moved): evict, retry by hostname once.
    // Only when nothing was sent (connect failure) or the method is a read: a
    // POST that died mid-flight (ECONNRESET) may have run server-side (CORE-R1).
    evictIpv4Cache(prepared.pinnedHost);
    if (!connectPhase && !isReadMethod(method)) {
      vlog(`${label} FAILED on pinned IP after connecting — not retrying a ${method}`, { error: redactString(String(err)) });
      throw networkError(err, label, method, false);
    }
    vlog(`${label} FAILED on pinned IP — evicting and retrying by hostname`, { error: redactString(String(err)) });
    try {
      response = await fetchOnce(url, rest, timeoutMs, `${label} (hostname retry)`, method);
    } catch (err2) {
      if (err2 instanceof CliError) throw err2;
      if (isAbortError(err2)) throw new CliError(`Request aborted: ${label}`, { code: "HTTP_ABORTED" });
      throw networkError(err2, label, method, isConnectPhaseError(err2));
    }
  }
  vlog(`${label} → ${response.status}`);
  return response;
}

/**
 * HTTP_TIMEOUT. For a non-GET the server received the request and may still
 * finish it (commit a draft test's SQL, publish, save): say so, and flag it in
 * details so nothing retries it blindly.
 */
function timeoutError(timeoutMs: number, label: string, method: string): CliError {
  const secs = Math.round(timeoutMs / 1000);
  const mayHaveCompleted = !isReadMethod(method);
  const message = mayHaveCompleted
    ? `Request timed out after ${secs}s: ${label}. The operation may still complete on the server — ` +
      `check its result before retrying (raise the limit with BELZ_HTTP_WRITE_TIMEOUT_MS).`
    : `Request timed out after ${secs}s: ${label} (raise the limit with BELZ_HTTP_TIMEOUT_MS).`;
  return new CliError(message, {
    code: "HTTP_TIMEOUT",
    details: { timeoutMs, method, mayHaveCompleted, retryable: !mayHaveCompleted },
  });
}

/**
 * HTTP_NETWORK_ERROR. A non-GET that failed after connecting (reset, closed
 * socket) may have reached the server: flag it like a timed-out write.
 */
function networkError(err: unknown, label: string, method: string, connectPhase: boolean): CliError {
  const reason = redactString(err instanceof Error ? err.message : String(err));
  const mayHaveCompleted = !connectPhase && !isReadMethod(method);
  const message = mayHaveCompleted
    ? `Network error: ${label}: ${reason}. The request may have reached the server — check its result before retrying.`
    : `Network error: ${label}: ${reason}`;
  return new CliError(message, {
    code: "HTTP_NETWORK_ERROR",
    details: { reason, method, connectPhase, mayHaveCompleted, retryable: !mayHaveCompleted },
  });
}

/** Can `body` be sent a second time (for a 401 retry)? Streams cannot. */
export function isReplayableBody(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body === "string") return true;
  if (body instanceof FormData || body instanceof URLSearchParams || body instanceof Blob) return true;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  return false;
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Memoize one in-flight async operation per key: concurrent callers share the
 * same promise; once it settles the next call starts a fresh one.
 */
export function singleFlight<T>() {
  const inflight = new Map<string, Promise<T>>();
  return (key: string, fn: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        return await fn();
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}

/** A minimal p-limit: at most `concurrency` tasks run at once. */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) run();
  };
  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(run);
      next();
    });
  };
}
