// Output-trimming helpers shared by the AD read commands.
//
// - `pruneEmpty` drops null / undefined / "" / [] / {} recursively (false and 0
//   are kept: they carry meaning). Used on --llm payloads so agents do not pay
//   for empty scaffolding.
// - `oneLine` / `abbreviate` squeeze SQL, code and SpEL onto one line.
// The `--fields a,b|all` helpers (parseFieldList / projectRow) live in core
// (src/output/fields.ts).

import { isEmptyValue } from "@belzabar/core";

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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Rich-text (AD UI) → plain text: `<br>` / block ends become " / ", tags dropped, common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\b[^>]*>|<\/?(p|div|li|ul|ol)\b[^>]*>/gi, " / ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#39|[a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s*\/\s*(\/\s*)+/g, " / ")
    .replace(/\s+/g, " ")
    .replace(/^\s*\/\s*|\s*\/\s*$/g, "")
    .trim();
}
