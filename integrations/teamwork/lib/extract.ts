// Item extraction from Teamwork ticket text.
//
// Codifies the three comment patterns documented in agents/release-prep/SKILL.md
// Stage 2, so the `belz tw items` linker no longer relies on an agent eyeballing
// comments. All functions here are pure and operate on a single text blob — the
// command layer (commands/items/index.ts) attaches comment provenance and merges.

// ── ID shapes ────────────────────────────────────────────────────────────────
// AD chain UUIDs and PD page IDs both appear as 32-hex or dashed-UUID strings.
const HEX32 = "[0-9a-fA-F]{32}";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ID = `(?:${UUID}|${HEX32})`;

/** Lowercase and strip dashes so draft/published/url forms dedupe to one key. */
export function normalizeHex(raw: string): string {
  return raw.toLowerCase().replace(/-/g, "");
}

export type ItemPattern = "ad-url" | "pd-page-url" | "pd-symbol-url" | "labeled-list";
export type PdKind = "draft" | "published" | "symbol" | "unknown";

export interface RawAdRef {
  uuid: string; // normalized: lowercase, dashless
  category: string | null; // from URL when present
  pattern: ItemPattern;
}

export interface RawPdRef {
  key: string; // normalized hex id, or symbol name
  kind: PdKind;
  versionRange: string | null; // "397233-402847" from compare?version=A-B
  pattern: ItemPattern;
}

export interface RawSqlRef {
  statement: string; // whitespace-collapsed, semicolon-terminated
  kind: "ddl" | "dml";
}

export interface RawExtraction {
  ad: RawAdRef[];
  pd: RawPdRef[];
  sql: RawSqlRef[];
  /** True when the text contains a labeled "...Published Id:" / "PD Pages Published:" list. */
  hasLabeledList: boolean;
}

// ── URL classification ───────────────────────────────────────────────────────

function extractVersionRange(url: string): string | null {
  const m = url.match(/version=(\d+-\d+)/);
  return m ? m[1]! : null;
}

function classifyUrl(url: string): RawAdRef | RawPdRef | null {
  let m: RegExpMatchArray | null;

  m = url.match(new RegExp(`automation-designer/([A-Za-z0-9_-]+)/(${ID})`));
  if (m) return { uuid: normalizeHex(m[2]!), category: m[1]!, pattern: "ad-url" };

  m = url.match(new RegExp(`ui-designer/page/(${ID})`));
  if (m) {
    return {
      key: normalizeHex(m[1]!),
      kind: "draft", // a page URL hex is the DRAFT id, never the deployable
      versionRange: extractVersionRange(url),
      pattern: "pd-page-url",
    };
  }

  m = url.match(/ui-designer\/symbol\/([^/?#\s]+)/);
  if (m) {
    return {
      key: decodeURIComponent(m[1]!),
      kind: "symbol",
      versionRange: extractVersionRange(url),
      pattern: "pd-symbol-url",
    };
  }

  return null;
}

// ── Labeled-list parsing (Patterns B & C) ────────────────────────────────────
// Catches bare hex CSV lists like `PD Pages Published : a,b,c` or
// `AD (Published Id): a,b` that aren't expressed as URLs.

function parseLabeledLine(line: string): { ad: RawAdRef[]; pd: RawPdRef[] } | null {
  const lm = line.match(/^\s*([A-Za-z][A-Za-z0-9 ()._/-]*?)\s*:\s*(.+)$/);
  if (!lm) return null;
  const label = lm[1]!.toLowerCase();
  // Strip URLs from the value — those are Pattern A's job. This pattern is
  // only for BARE hex CSV lists ("AD (Published Id): a,b").
  const bare = lm[2]!.replace(/https?:\/\/\S+/g, "");
  const hexes = bare.match(new RegExp(ID, "g")) ?? [];
  if (hexes.length === 0) return null;

  const isPd = /\bpd\b|page/.test(label);
  const isAd = /\bad\b|method/.test(label);
  if (isPd === isAd) return null; // ambiguous or neither
  const published = /publish/.test(label);

  if (isPd) {
    return {
      ad: [],
      pd: hexes.map((h) => ({
        key: normalizeHex(h),
        kind: (published ? "published" : "unknown") as PdKind,
        versionRange: null,
        pattern: "labeled-list" as ItemPattern,
      })),
    };
  }
  return {
    ad: hexes.map((h) => ({ uuid: normalizeHex(h), category: null, pattern: "labeled-list" as ItemPattern })),
    pd: [],
  };
}

// ── SQL extraction ───────────────────────────────────────────────────────────
// Heuristic: scan for statements opening with a known keyword up to the first
// semicolon. DDL → release "DB" bucket; DML → "Corrective fixes" bucket.

const DDL_RE = /\b(?:ALTER\s+TABLE|CREATE\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+TABLE|DROP\s+INDEX|TRUNCATE\s+TABLE)\b[\s\S]*?;/gi;
const DML_RE = /\b(?:INSERT\s+INTO|UPDATE\s+[\w".]+\s+SET|DELETE\s+FROM)\b[\s\S]*?;/gi;

function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function extractSql(text: string): RawSqlRef[] {
  const out: RawSqlRef[] = [];
  for (const m of text.matchAll(DDL_RE)) out.push({ statement: collapse(m[0]), kind: "ddl" });
  for (const m of text.matchAll(DML_RE)) out.push({ statement: collapse(m[0]), kind: "dml" });
  return out;
}

// ── Top-level extraction ─────────────────────────────────────────────────────

export function extractFromText(text: string): RawExtraction {
  const ad: RawAdRef[] = [];
  const pd: RawPdRef[] = [];

  // Pattern A — URLs.
  const urls = text.match(/https?:\/\/[^\s)<>"'\]]+/g) ?? [];
  for (const url of urls) {
    const classified = classifyUrl(url);
    if (!classified) continue;
    if ("uuid" in classified) ad.push(classified);
    else pd.push(classified);
  }

  // Patterns B & C — labeled hex CSV lists.
  let hasLabeledList = false;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLabeledLine(line);
    if (!parsed) continue;
    hasLabeledList = true;
    ad.push(...parsed.ad);
    pd.push(...parsed.pd);
  }

  return { ad, pd, sql: extractSql(text), hasLabeledList };
}
