// The one transport every belz HTTP call goes through (AD/PD via apiFetch,
// Teamwork, Jenkins):
//   - IPv4 pinning (dns.ts) with pin eviction + one hostname retry when the
//     pinned IP fails to connect (CORE-20);
//   - a default timeout (60 s; per call `timeoutMs`, env BELZ_HTTP_TIMEOUT_MS)
//     mapped to CliError HTTP_TIMEOUT instead of hanging forever (CORE-13);
//   - network failures mapped to CliError HTTP_NETWORK_ERROR (never an
//     UNHANDLED_EXCEPTION);
//   - verbose logging with secrets redacted.

import { CliError } from "../command";
import { vlog, vtime } from "../verbose";
import { evictIpv4Cache, prepareIpv4Fetch } from "./dns";
import { redactString } from "./redact";

export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

export interface HttpInit extends RequestInit {
  /** Abort after this many ms waiting for response headers. 0 disables. Default 60 s (BELZ_HTTP_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Pin the request to the host's IPv4 address (default true). */
  pinIpv4?: boolean;
}

export function defaultTimeoutMs(): number {
  const raw = process.env.BELZ_HTTP_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HTTP_TIMEOUT_MS;
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
    if (timedOut) {
      throw new CliError(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${label}`, {
        code: "HTTP_TIMEOUT",
        details: { timeoutMs },
      });
    }
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
  const timeoutMs = t ?? defaultTimeoutMs();
  const method = (rest.method ?? "GET").toUpperCase();
  const label = `HTTP ${method} ${safeUrl(url)}`;

  const prepared = pinIpv4 ? await prepareIpv4Fetch(url, rest) : { url, init: rest as RequestInit, pinnedHost: undefined };

  let response: Response;
  try {
    response = await fetchOnce(prepared.url, prepared.init, timeoutMs, label);
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (isAbortError(err)) {
      throw new CliError(`Request aborted: ${label}`, { code: "HTTP_ABORTED" });
    }
    if (!prepared.pinnedHost) throw networkError(err, label);
    // The pinned IP may be stale (load balancer moved): evict, retry by hostname once.
    vlog(`${label} FAILED on pinned IP — evicting and retrying by hostname`, { error: redactString(String(err)) });
    evictIpv4Cache(prepared.pinnedHost);
    try {
      response = await fetchOnce(url, rest, timeoutMs, `${label} (hostname retry)`);
    } catch (err2) {
      if (err2 instanceof CliError) throw err2;
      if (isAbortError(err2)) throw new CliError(`Request aborted: ${label}`, { code: "HTTP_ABORTED" });
      throw networkError(err2, label);
    }
  }
  vlog(`${label} → ${response.status}`);
  return response;
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
