// Output-trimming helpers shared by the AD read commands (Stage 7: 7.1 / 7.9).
//
// - `pruneEmpty` drops null / undefined / "" / [] / {} recursively (false and 0
//   are kept: they carry meaning). Used on --llm payloads so agents do not pay
//   for empty scaffolding.
// - `oneLine` / `abbreviate` squeeze SQL, code and SpEL onto one line.
// - `parseFieldList` / `projectRow` implement the `--fields a,b|all` convention
//   (same as `pd show --fields`): compact default rows, explicit picks, or all.

import { CliError } from "@belzabar/core";

export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** Recursively drop empty values (see isEmptyValue). Arrays keep their order; empty array items are dropped. */
export function pruneEmpty<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(walk).filter((x) => !isEmptyValue(x));
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
        const w = walk(raw);
        if (!isEmptyValue(w)) out[k] = w;
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Collapse all whitespace runs (newlines included) to one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One-line text cut at `max` chars with a `…(+N)` marker. `max <= 0` = no limit. */
export function abbreviate(text: string, max: number): string {
  const flat = oneLine(text);
  if (max <= 0 || flat.length <= max) return flat;
  return `${flat.slice(0, max)}…(+${flat.length - max})`;
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
  const fields = selection.mode === "pick" ? selection.fields : defaults;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in full && !isEmptyValue(full[f])) out[f] = full[f];
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Rich-text (AD UI) → plain text: `<br>` / block ends become " / ", tags dropped, common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\b[^>]*>|<\/(p|div|li)>/gi, " / ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#39|[a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s*\/\s*(\/\s*)+/g, " / ")
    .replace(/\s+/g, " ")
    .replace(/^\s*\/\s*|\s*\/\s*$/g, "")
    .trim();
}
