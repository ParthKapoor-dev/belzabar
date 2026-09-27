// The one transport every belz HTTP call goes through (AD/PD via apiFetch,
// Teamwork, Jenkins):
//   - IPv4 pinning (dns.ts) with pin eviction + one hostname retry when the
//     pinned IP fails to connect (CORE-20);
//   - a default timeout mapped to CliError HTTP_TIMEOUT instead of hanging
//     forever (CORE-13): 60 s for GET/HEAD, 300 s for anything else (AD test,
//     run, SQL, save/publish execute server-side and are legitimately slow).
//     Per call `timeoutMs` (0 / "none" disables); env BELZ_HTTP_TIMEOUT_MS
//     (both defaults) and BELZ_HTTP_WRITE_TIMEOUT_MS (non-GET only). A timed-out
//     non-GET is never retried and says it may still complete server-side;
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
export type TimeoutOption = number | "none";

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
export function isReadMethod(method: string | undefined): boolean {
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
    return res;
  } catch (err) {
    stop();
    if (timedOut) throw timeoutError(timeoutMs, label, method);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
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
    if (!prepared.pinnedHost) throw networkError(err, label);
    // The pinned IP may be stale (load balancer moved): evict, retry by hostname once.
    vlog(`${label} FAILED on pinned IP — evicting and retrying by hostname`, { error: redactString(String(err)) });
    evictIpv4Cache(prepared.pinnedHost);
    try {
      response = await fetchOnce(url, rest, timeoutMs, `${label} (hostname retry)`, method);
    } catch (err2) {
      if (err2 instanceof CliError) throw err2;
      if (isAbortError(err2)) throw new CliError(`Request aborted: ${label}`, { code: "HTTP_ABORTED" });
      throw networkError(err2, label);
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

function networkError(err: unknown, label: string): CliError {
  const reason = redactString(err instanceof Error ? err.message : String(err));
  return new CliError(`Network error: ${label}: ${reason}`, {
    code: "HTTP_NETWORK_ERROR",
    details: { reason },
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
