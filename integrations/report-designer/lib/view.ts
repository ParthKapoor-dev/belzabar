// Compact views of a report definition for `rd show` and the write commands.

import { isObj, str, type Obj } from "@belzabar/core";

export interface ColumnView {
  id: string;
  name: string;
  label: string;
  type: string;
  filterable: boolean;
  reportable: boolean;
  /** "ASC" / "DESC": the report's row order; null = unsorted. */
  sortBy: string | null;
  width: number | null;
  starred: boolean;
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
    sortBy: str(c.sortBy) || null,
    width: typeof c.width === "number" ? c.width : null,
    starred: c.starred === true,
  }));
}

interface SharingUser {
  id: number | null;
  name: string;
  email: string | null;
}

interface SharingGroup {
  id: number | null;
  name: string;
}

/** Who the report is shared with, per access level (the owner aside). */
export interface SharingView {
  view: { users: SharingUser[]; groups: SharingGroup[] };
  edit: { users: SharingUser[]; groups: SharingGroup[] };
}

const idOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** The definition's `contributors` (`{view|edit: {contributors, groupContributors}}`) as names. */
export function sharingView(contributors: unknown): SharingView {
  const level = (key: "view" | "edit") => {
    const l = isObj(contributors) && isObj(contributors[key]) ? contributors[key] : {};
    const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
    return {
      users: list(l.contributors).map((u) => ({
        id: idOrNull(u.id),
        name: str(u.fullName) || [str(u.firstName), str(u.lastName)].filter(Boolean).join(" ") || str(u.email) || String(u.id ?? ""),
        email: str(u.email) || null,
      })),
      groups: list(l.groupContributors).map((g) => ({ id: idOrNull(g.id), name: str(g.name) || str(g.titleGT) || String(g.id ?? "") })),
    };
  };
  return { view: level("view"), edit: level("edit") };
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
