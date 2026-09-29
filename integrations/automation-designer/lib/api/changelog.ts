// AD changelog client — change notes recorded against a chain definition.
//
// A change note must be recorded before a method is published. The endpoint is
// keyed by the numeric chain-definition id (V1RawMethodResponse.id /
// HydratedMethod.numericId), NOT the uuid.
//
// No command imports this file directly — use lib/api/index.ts:adApi.

import { apiFetch, CliError, ensureApiOk, readJsonOrNull } from "@belzabar/core";

const ENTITY_TYPE = "AUTOMATION_CHAIN_DEFINITION";
const CHANGELOG_TYPE = "USER_GENERATED";

export interface ChangelogEntry {
  id: string;
  comment: string;
  user?: { fullName?: string; email?: string; [key: string]: unknown };
  createdAt: number;
  changelogType: string;
}

function checkResponse(response: Response, path: string): Promise<void> {
  return ensureApiOk(response, { path, code: "AD_CHANGELOG_ERROR" });
}

/**
 * The current authenticated user, in the shape the changelog payload expects.
 * Backed by GET /rest/api/users/me, which wraps the user under a `user` key.
 */
export async function fetchCurrentUser(): Promise<Record<string, unknown>> {
  const path = "/rest/api/users/me";
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  const body = await readJsonOrNull<{ user?: Record<string, unknown> }>(response, { path });
  if (!body?.user) {
    throw new CliError("Could not resolve the current user from /rest/api/users/me.", {
      code: "AD_CURRENT_USER_UNAVAILABLE",
      details: { path },
    });
  }
  return body.user;
}

/** Change notes recorded against a chain (server order — newest first). */
export async function listChangelog(chainId: number): Promise<ChangelogEntry[]> {
  const path = `/rest/api/automation/chain/changelog/${chainId}`;
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  const body = await readJsonOrNull<unknown>(response, { path });
  return Array.isArray(body) ? (body as ChangelogEntry[]) : [];
}

/**
 * Record a change note against a chain. Returns the created entry's id, or
 * null when it could not be identified.
 *
 * Live wire (AD-19): the POST answers `{"success":true}` with no id,
 * so the id is looked up afterwards in the chain's list: the newest
 * USER_GENERATED entry with the same comment created at/after the POST.
 * `{"success":false}` is a failure (AD_CHANGELOG_ERROR).
 */
export async function addChangelog(chainId: number, comment: string): Promise<string | null> {
  const user = await fetchCurrentUser();
  const path = `/rest/api/automation/chain/changelog/${chainId}`;
  const createdAt = Date.now();
  const payload = {
    comment,
    entityType: ENTITY_TYPE,
    changelogType: CHANGELOG_TYPE,
    createdAt,
    user,
  };
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await checkResponse(response, path);
  const body = ((await readJsonOrNull<{ id?: unknown; success?: unknown }>(response, { path }).catch(() => null)) ?? {}) as { id?: unknown; success?: unknown };
  if (body.success === false) {
    throw new CliError(`The server refused the change note on chain ${chainId}.`, {
      code: "AD_CHANGELOG_ERROR",
      details: { path, body },
    });
  }
  if (typeof body.id === "string" && body.id) return body.id;
  try {
    return findChangelogId(await listChangelog(chainId), comment, createdAt);
  } catch {
    return null;
  }
}

/** The id of the note we just posted: newest USER_GENERATED entry with this comment, not older than the POST (60 s clock skew). */
export function findChangelogId(entries: ChangelogEntry[], comment: string, postedAt: number): string | null {
  const matches = entries
    .filter((e) => e.comment === comment && e.changelogType === CHANGELOG_TYPE)
    .filter((e) => typeof e.createdAt !== "number" || e.createdAt >= postedAt - 60_000)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return matches[0]?.id ?? null;
}
