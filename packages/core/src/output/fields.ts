// The `--fields a,b|all` convention shared by the read commands (AD find /
// services / categories / changelog, PD show): compact default rows, explicit
// picks, or the full row; empty values are dropped from projected rows.

import { CliError } from "../command";

/** null / undefined / "" / [] / {} (false and 0 carry meaning and are kept). */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export type FieldSelection = { mode: "default" } | { mode: "all" } | { mode: "pick"; fields: string[] };

/**
 * Parse `--fields a,b,…` / `--fields all`. Unknown names → INVALID_VALUE
 * listing the known ones. `undefined` (flag absent) → default selection.
 */
export function parseFieldList(raw: string | undefined, known: readonly string[], flag = "--fields"): FieldSelection {
  if (raw === undefined) return { mode: "default" };
  const list = raw.split(",").map((f) => f.trim()).filter(Boolean);
  if (list.includes("all")) return { mode: "all" };
  const bad = list.filter((f) => !known.includes(f));
  if (bad.length || list.length === 0) {
    throw new CliError(`${flag}: unknown field(s) ${bad.join(", ") || "(none given)"}. Known: ${known.join(",")}, or "all".`, {
      code: "INVALID_VALUE",
      details: { flag, unknown: bad, known },
    });
  }
  return { mode: "pick", fields: list };
}

/** The named fields of `full` that are present and not empty, in `fields` order. */
export function pickFields(full: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in full && !isEmptyValue(full[f])) out[f] = full[f];
  return out;
}

/**
 * Project one full row: default → `defaults` with empty values dropped;
 * pick → the named fields (empty ones dropped); all → the full row unchanged.
 */
export function projectRow<R extends Record<string, unknown>>(
  full: R,
  selection: FieldSelection,
  defaults: readonly string[],
): Record<string, unknown> {
  if (selection.mode === "all") return full;
  return pickFields(full, selection.mode === "pick" ? selection.fields : defaults);
}
