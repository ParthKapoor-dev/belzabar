// Read-only guard for the fixture capture tool. Kept dependency-free so tests
// can import it without loading @belzabar/core (which reads ~/.belz at import).

export class CaptureRefused extends Error {}

/**
 * The one env captures may read: BELZ_CAPTURE_ENV (a non-production env you
 * choose; nothing is built in). Throws when unset.
 */
export function captureEnv(value: string | undefined = process.env.BELZ_CAPTURE_ENV): string {
  const env = value?.trim();
  if (!env) throw new CaptureRefused("set BELZ_CAPTURE_ENV=<env> to name the (non-production) env fixtures are captured from");
  return env;
}

/** Throws unless `env` is the capture env. */
export function assertCaptureEnv(env: string, allowed: string = captureEnv()): void {
  if (env !== allowed) {
    throw new CaptureRefused(`fixture capture is limited to ${allowed} (got "${env}")`);
  }
}

/** Throws unless the request is a GET. Login POSTs happen inside core, not here. */
export function assertReadOnly(method: string | undefined): void {
  const m = (method ?? "GET").toUpperCase();
  if (m !== "GET") throw new CaptureRefused(`fixture capture is read-only; refusing ${m}`);
}
