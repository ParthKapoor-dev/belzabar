// Read-only guard for the fixture capture tool. Kept dependency-free so tests
// can import it without loading @belzabar/core (which reads ~/.belz at import).

export const CAPTURE_ENV = "sems-dev";

export class CaptureRefused extends Error {}

/** Throws unless the env is sems-dev. */
export function assertCaptureEnv(env: string): void {
  if (env !== CAPTURE_ENV) {
    throw new CaptureRefused(`fixture capture is limited to ${CAPTURE_ENV} (got "${env}")`);
  }
}

/** Throws unless the request is a GET. Login POSTs happen inside core, not here. */
export function assertReadOnly(method: string | undefined): void {
  const m = (method ?? "GET").toUpperCase();
  if (m !== "GET") throw new CaptureRefused(`fixture capture is read-only; refusing ${m}`);
}
