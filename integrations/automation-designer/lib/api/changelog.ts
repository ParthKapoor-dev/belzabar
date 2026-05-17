// AD changelog client — change notes recorded against a chain definition.
//
// A change note must be recorded before a method is published. The endpoint is
// keyed by the numeric chain-definition id (V1RawMethodResponse.id /
// HydratedMethod.numericId), NOT the uuid.
//
// No command imports this file directly — use lib/api/index.ts:adApi.

import { apiFetch, CliError } from "@belzabar/core";

const ENTITY_TYPE = "AUTOMATION_CHAIN_DEFINITION";
const CHANGELOG_TYPE = "USER_GENERATED";

export interface ChangelogEntry {
  id: string;
  comment: string;
  user?: { fullName?: string; email?: string; [key: string]: unknown };
  createdAt: number;
  changelogType: string;
}

async function checkResponse(response: Response, path: string): Promise<void> {
  if (response.ok) return;
  let body: unknown;
  try {
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 1024);
    }
  } catch {
    body = "(response body unreadable)";
  }
  throw new CliError(`${response.status} ${response.statusText} on ${path}`, {
    code: "AD_CHANGELOG_ERROR",
    details: { path, status: response.status, body },
  });
}

/**
 * The current authenticated user, in the shape the changelog payload expects.
 * Backed by GET /rest/api/users/me, which wraps the user under a `user` key.
 */
export async function fetchCurrentUser(): Promise<Record<string, unknown>> {
  const path = "/rest/api/users/me";
  const response = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  await checkResponse(response, path);
  const body = (await response.json()) as { user?: Record<string, unknown> };
  if (!body.user) {
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
  const body = await response.json();
  return Array.isArray(body) ? (body as ChangelogEntry[]) : [];
}

/** Record a change note against a chain. Returns the created entry id (if any). */
export async function addChangelog(chainId: number, comment: string): Promise<string> {
  const user = await fetchCurrentUser();
  const path = `/rest/api/automation/chain/changelog/${chainId}`;
  const payload = {
    comment,
    entityType: ENTITY_TYPE,
    changelogType: CHANGELOG_TYPE,
    createdAt: Date.now(),
    user,
  };
  const response = await apiFetch(path, {
    method: "POST",
    authMode: "Bearer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await checkResponse(response, path);
  const body = (await response.json().catch(() => ({}))) as { id?: string };
  return body.id ?? "";
}
