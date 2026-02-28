import { CliError } from "@belzabar/core";
import { DB_MIGRATION_TOOL_BASE_URL } from "./constants";
import type { CleanupExecutionResult, StartExecutionInput, StartExecutionResult } from "./types";

interface StartExecutionOptions {
  fetchFn?: typeof fetch;
}

interface CleanupExecutionOptions {
  fetchFn?: typeof fetch;
  cookieHeader?: string;
}

function normalizeIds(ids: string[]): string {
  return ids.join("\n");
}

function getSetCookieValues(headers: Headers): string[] {
  const bunHeaders = headers as unknown as { getAll?: (name: "set-cookie" | "Set-Cookie") => string[] };
  if (typeof bunHeaders.getAll === "function") {
    const values = bunHeaders.getAll("set-cookie");
    if (Array.isArray(values) && values.length > 0) return values;
  }

  const one = headers.get("set-cookie");
  return one ? [one] : [];
}

function toCookieHeader(values: string[]): string | undefined {
  const map = new Map<string, string>();

  for (const value of values) {
    const firstPart = value.split(";")[0]?.trim();
    if (!firstPart) continue;
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = firstPart.slice(0, eqIdx).trim();
    const val = firstPart.slice(eqIdx + 1).trim();
    if (!key) continue;
    map.set(key, val);
  }

  if (map.size === 0) return undefined;
  return Array.from(map.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function mergeCookieHeaders(...headers: Array<string | undefined>): string | undefined {
  const merged = new Map<string, string>();
  for (const header of headers) {
    if (!header) continue;
    const parts = header.split(";").map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      merged.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }

  if (merged.size === 0) return undefined;
  return Array.from(merged.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function bootstrapToolSession(fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchFn(`${DB_MIGRATION_TOOL_BASE_URL}/index.html`, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Bun/1.0 (Belzabar CLI)",
      },
    });

    return toCookieHeader(getSetCookieValues(response.headers));
  } catch {
    return undefined;
  }
}

export async function startMigrationExecution(
  input: StartExecutionInput,
  options: StartExecutionOptions = {}
): Promise<StartExecutionResult> {
  const fetchFn = options.fetchFn || fetch;
  const bootstrapCookie = await bootstrapToolSession(fetchFn);
  const form = new FormData();
  form.append("__script_name", input.scriptName);
  form.append("Choose a profile", input.profile);
  form.append("Module Name", input.moduleName);
  form.append("List of UUIDs", normalizeIds(input.ids));
  form.append("Use CRUD API?", input.useCrud);
  form.append("Is Async Migration", input.isAsync);
  form.append("Migrate Dependent methods?", input.migrateDependents);
  form.append("Migration ID (uuid)", input.migrationId || "");

  const response = await fetchFn(`${DB_MIGRATION_TOOL_BASE_URL}/executions/start`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      Origin: DB_MIGRATION_TOOL_BASE_URL,
      Referer: `${DB_MIGRATION_TOOL_BASE_URL}/index.html`,
      ...(bootstrapCookie ? { Cookie: bootstrapCookie } : {}),
    },
    body: form,
  });

  const body = (await response.text()).trim();

  if (!response.ok) {
    throw new CliError(`Migration execution start failed (${response.status}).`, {
      code: "MIGRATE_START_FAILED",
      details: { status: response.status, body },
    });
  }

  const executionId = body.replace(/[\r\n\s]+/g, "");
  if (!executionId) {
    throw new CliError("Execution start response did not include an execution ID.", {
      code: "MIGRATE_EXECUTION_ID_MISSING",
      details: { body },
    });
  }

  const responseCookie = toCookieHeader(getSetCookieValues(response.headers));
  const cookieHeader = mergeCookieHeaders(bootstrapCookie, responseCookie);

  return {
    executionId,
    status: response.status,
    body,
    cookieHeader,
  };
}

export async function cleanupMigrationExecution(
  executionId: string,
  options: CleanupExecutionOptions = {}
): Promise<CleanupExecutionResult> {
  const fetchFn = options.fetchFn || fetch;

  try {
    const response = await fetchFn(`${DB_MIGRATION_TOOL_BASE_URL}/executions/cleanup/${executionId}`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: DB_MIGRATION_TOOL_BASE_URL,
        Referer: `${DB_MIGRATION_TOOL_BASE_URL}/index.html`,
        ...(options.cookieHeader ? { Cookie: options.cookieHeader } : {}),
      },
    });

    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
