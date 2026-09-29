// Raw GETs of the two Expertly entities belz resolves by id: an AD chain
// (method) and a PD page/component. One place owns the wire rule "not found is
// a 404 OR a 2xx with an empty / `null` body" (the chain GET answers an unknown
// uuid with 200 + empty body); each caller maps the outcome to its own codes.

import type { CliError } from "../command";
import { apiFetch } from "../http/api";

export const adChainPath = (uuid: string): string => `/rest/api/automation/chain/${uuid}`;
export const pdPagePath = (id: string): string => `/rest/api/pagedesigner/pages/${id}`;

export type RawEntityResult<T> =
  | { found: true; body: T }
  | { found: false; reason: "http-404"; res: Response }
  | { found: false; reason: "empty" };

export interface RawEntityOptions {
  /** The error for a non-OK, non-404 response. */
  onError: (res: Response, path: string) => Promise<CliError> | CliError;
  /** The error for a 2xx body that is not JSON. Default: treat it as empty (not found). */
  badJson?: (text: string, res: Response) => CliError;
}

/** GET `path` (Bearer) and classify the answer; see the file header. */
export async function fetchRawEntity<T>(path: string, opts: RawEntityOptions): Promise<RawEntityResult<T>> {
  const res = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  if (res.status === 404) return { found: false, reason: "http-404", res };
  if (!res.ok) throw await opts.onError(res, path);
  const text = await res.text();
  if (text.trim() === "" || text.trim() === "null") return { found: false, reason: "empty" };
  try {
    return { found: true, body: JSON.parse(text) as T };
  } catch {
    if (opts.badJson) throw opts.badJson(text, res);
    return { found: false, reason: "empty" };
  }
}

/** The raw V1 AD chain record for `uuid`. */
export function fetchRawChain<T = unknown>(uuid: string, opts: RawEntityOptions): Promise<RawEntityResult<T>> {
  return fetchRawEntity<T>(adChainPath(uuid), opts);
}

/** The raw PD page/component record for `id`. */
export function fetchRawPage<T = unknown>(id: string, opts: RawEntityOptions): Promise<RawEntityResult<T>> {
  return fetchRawEntity<T>(pdPagePath(id), opts);
}
