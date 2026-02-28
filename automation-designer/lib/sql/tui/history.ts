import { dirname, join } from "path";
import { mkdir } from "fs/promises";
import { BELZ_CONFIG_DIR } from "@belzabar/core";

export const SQL_HISTORY_LIMIT = 2000;
const SQL_HISTORY_PATH = join(BELZ_CONFIG_DIR, "sql_history");

function normalizeEntry(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

export function getSqlHistoryPath(): string {
  return SQL_HISTORY_PATH;
}

export async function loadSqlHistory(): Promise<string[]> {
  const file = Bun.file(SQL_HISTORY_PATH);
  if (!(await file.exists())) {
    return [];
  }

  try {
    const content = await file.text();
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.slice(-SQL_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export async function persistSqlHistory(existing: string[], newEntries: string[]): Promise<void> {
  if (newEntries.length === 0) {
    return;
  }

  const merged: string[] = [...existing];
  for (const entry of newEntries) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;

    if (merged.length === 0 || merged[merged.length - 1] !== normalized) {
      merged.push(normalized);
    }
  }

  const capped = merged.slice(-SQL_HISTORY_LIMIT);
  await mkdir(dirname(SQL_HISTORY_PATH), { recursive: true });
  await Bun.write(SQL_HISTORY_PATH, `${capped.join("\n")}\n`);
}
