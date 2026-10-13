// Compact views of a report definition for `rd show` and the write commands.

import { isObj, str, type Obj } from "@belzabar/core";

export interface ColumnView {
  id: string;
  name: string;
  label: string;
  type: string;
  filterable: boolean;
  reportable: boolean;
}

export interface FilterView {
  column: string;
  operator: string;
  value: unknown;
  applied: boolean;
}

export function columnViews(columns: Obj[]): ColumnView[] {
  return columns.map((c) => ({
    id: String(c.id ?? ""),
    name: str(c.name) ?? "",
    label: str(c.label) ?? str(c.name) ?? "",
    type: str(c.type) ?? "",
    filterable: c.filterable === true,
    reportable: c.reportable !== false,
  }));
}

export function filterViews(filters: Obj[], columns: Obj[]): FilterView[] {
  const names = new Map(columns.map((c) => [String(c.id), str(c.name) ?? String(c.id)]));
  return filters.map((f) => {
    const colObj = isObj(f.column) ? f.column : {};
    const op = isObj(f.operand) ? f.operand : {};
    return {
      column: names.get(String(f.columnId)) ?? str(colObj.name) ?? String(f.columnId ?? ""),
      operator: str(op.label) ?? str(op.type) ?? String(f.operandId ?? ""),
      value: f.value ?? null,
      applied: f.applied !== false,
    };
  });
}

export function summaryViews(summaries: Obj[]): string[] {
  return summaries.map((s) => {
    const col = isObj(s.column) ? str(s.column.name) : str(s.columnName);
    const kind = str(s.type) ?? str(s.label) ?? str(s.name) ?? "summary";
    return col ? `${kind}(${col})` : kind;
  });
}
