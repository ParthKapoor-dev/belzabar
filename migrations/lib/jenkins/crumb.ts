import type { JenkinsAuth } from "./auth";
import { buildHeaders } from "./auth";

export interface Crumb {
  field: string;
  value: string;
  cookie?: string;
}

let cachedCrumb: { auth: string; crumb: Crumb } | null = null;

/**
 * Extract `name=value` from a comma-joined Set-Cookie header. We only need the
 * cookie pair (not Path/Domain/etc.) for replay on the build trigger request.
 */
function pickSessionCookies(setCookieHeader: string | null): string | undefined {
  if (!setCookieHeader) return undefined;
  const pairs: string[] = [];
  for (const part of setCookieHeader.split(/,(?=[^ ]+=)/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const pair = trimmed.split(";")[0]?.trim();
    if (pair && /^[A-Za-z0-9._-]+=/.test(pair)) pairs.push(pair);
  }
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

/**
 * Fetch a CSRF crumb. Jenkins binds the crumb to the JSESSIONID cookie
 * returned in the same response, so we capture and return both — callers
 * MUST replay the cookie on the request that uses the crumb.
 */
export async function fetchCrumb(auth: JenkinsAuth): Promise<Crumb | null> {
  const cacheKey = `${auth.user}:${auth.password}@${auth.baseUrl}`;
  if (cachedCrumb && cachedCrumb.auth === cacheKey) return cachedCrumb.crumb;

  const url = `${auth.baseUrl}/crumbIssuer/api/json`;
  const res = await fetch(url, { headers: buildHeaders(auth) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch Jenkins crumb (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { crumb: string; crumbRequestField: string };
  const cookie = pickSessionCookies(res.headers.get("set-cookie"));
  const crumb: Crumb = { field: json.crumbRequestField, value: json.crumb, cookie };
  cachedCrumb = { auth: cacheKey, crumb };
  return crumb;
}

export function resetCrumbCache(): void {
  cachedCrumb = null;
}
