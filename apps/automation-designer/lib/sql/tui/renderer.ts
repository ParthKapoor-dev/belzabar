import Table from "cli-table3";
import type { SqlTuiFormat } from "./types";

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toObjectRows(rows: unknown[]): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return row as Record<string, unknown>;
    }
    return { value: row };
  });
}

function getPages(totalRows: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalRows / pageSize));
}

function getPageRows(rows: unknown[], page: number, pageSize: number): unknown[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function renderTablePage(rows: unknown[]): void {
  const objectRows = toObjectRows(rows);
  const headers = Array.from(new Set(objectRows.flatMap((row) => Object.keys(row))));

  if (headers.length === 0) {
    console.log("(0 rows)");
    return;
  }

  const table = new Table({ head: headers, wordWrap: true });
  for (const row of objectRows) {
    table.push(headers.map((header) => scalar(row[header])));
  }

  console.log(table.toString());
}

function renderJsonPage(rows: unknown[]): void {
  console.log(JSON.stringify(rows, null, 2));
}

export async function renderRowsWithPagination(options: {
  rows: unknown[];
  format: SqlTuiFormat;
  pageSize: number;
  ask: (prompt: string) => Promise<string>;
}): Promise<void> {
  const totalRows = options.rows.length;
  if (totalRows === 0) {
    console.log("(0 rows)");
    return;
  }

  const totalPages = getPages(totalRows, options.pageSize);
  let page = 1;

  while (true) {
    const pageRows = getPageRows(options.rows, page, options.pageSize);

    console.log(`\nRows ${((page - 1) * options.pageSize) + 1}-${((page - 1) * options.pageSize) + pageRows.length} of ${totalRows}`);
    if (options.format === "json") {
      renderJsonPage(pageRows);
    } else {
      renderTablePage(pageRows);
    }

    if (totalPages <= 1) {
      return;
    }

    const nav = (await options.ask(`Page ${page}/${totalPages} [n=next, p=prev, q=quit pager]: `)).trim().toLowerCase();
    if (nav === "q" || nav === "") {
      return;
    }

    if (nav === "n" || nav === "next") {
      if (page < totalPages) page += 1;
      continue;
    }

    if (nav === "p" || nav === "prev") {
      if (page > 1) page -= 1;
      continue;
    }
  }
}
