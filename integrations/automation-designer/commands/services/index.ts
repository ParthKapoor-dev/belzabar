import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { normalizeUuid } from "../../lib/ids";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { abbreviate, parseFieldList, projectRow, type FieldSelection } from "../../lib/compact";
import { scoreFuzzy } from "../../lib/method-finder";

interface ServicesArgs {
  internal: boolean;
  search?: string;
  limit?: number;
  fields: FieldSelection;
}

interface ServiceRow {
  /** Chain-category id (same `id` as `ad categories`). */
  id: number | null;
  /** Trimmed chain-category uuid. */
  uuid: string;
  systemUuid: string | null;
  name: string;
  label: string;
  type: string;
  internalService: boolean;
  aliasNames: string[];
  description: string;
  /** --search only: rank score (sum over query words of the best name/label/alias/description hit). */
  score?: number;
}

interface ServicesData {
  total: number;
  filter?: { internal?: true; search?: string };
  services: Array<Record<string, unknown>>;
}

// 7.9: compact rows by default (label / aliases only when they differ from the
// name, description cut at 100 chars, empties dropped); --fields picks, --fields all = full rows.
export const SERVICE_FIELDS = ["name", "id", "uuid", "systemUuid", "label", "type", "internalService", "aliasNames", "description", "score"] as const;
const DEFAULT_FIELDS = ["name", "id", "type", "internalService", "label", "aliasNames", "description", "score"];

export const args = defineArgs({
  command: "belz ad services",
  flags: {
    ...AD_COMMON_FLAGS,
    internal: { type: "boolean" },
    search: { type: "string" },
    limit: { type: "number", integer: true, min: 1, max: 2000 },
    fields: { type: "string" },
  },
});

/**
 * 7.5: rank services for a free-text query. Each query word scores its best
 * hit over name (1.0), label (0.95), aliases (0.92) and description (0.6),
 * using the method index's scorer (exact > prefix > word start > substring >
 * fuzzy); the service score is the sum. Zero-score services are dropped.
 */
export function rankServices<T extends { name: string; label: string; aliasNames: string[]; description: string }>(
  rows: T[],
  query: string,
): Array<T & { score: number }> {
  const words = query.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 0);
  const whole = query.trim();
  const out: Array<T & { score: number }> = [];
  for (const r of rows) {
    const scoreWord = (w: string) =>
      Math.max(
        scoreFuzzy(w, r.name, 1),
        scoreFuzzy(w, r.label, 0.95),
        ...r.aliasNames.map((a) => scoreFuzzy(w, a, 0.92)),
        r.description ? scoreFuzzy(w, r.description, 0.6) : 0,
      );
    let score = words.reduce((sum, w) => sum + scoreWord(w), 0);
    if (words.length > 1) score = Math.max(score, scoreWord(whole) * words.length);
    if (score > 0) out.push({ ...r, score });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

const command: CommandModule<ServicesArgs, ServicesData> = {
  schema: "ad.services",
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    resolveAdCommon(flags, "list", "services");
    return { internal: flags.internal, search: flags.search, limit: flags.limit, fields: parseFieldList(flags.fields, SERVICE_FIELDS) };
  },
  async execute({ internal, search, limit, fields }) {
    const raw = (await adApi.listServices({ limit: 2000, offset: 0 })) as unknown;
    const result = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as any)?.result)
        ? (raw as any).result
        : [];

    const services: ServiceRow[] = [];
    for (const item of result) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      services.push({
        id: typeof r.id === "number" ? r.id : null,
        uuid: normalizeUuid(r.uuid) ?? "",
        systemUuid: normalizeUuid(r.automationSystemUuid),
        name: typeof r.name === "string" ? r.name : "",
        label: typeof r.label === "string" ? (r.label as string) : "",
        type: typeof r.type === "string" ? r.type : "",
        internalService: r.internalService === true,
        aliasNames: Array.isArray(r.aliasName)
          ? (r.aliasName as unknown[]).filter((a): a is string => typeof a === "string")
          : [],
        description: typeof r.description === "string" ? r.description.trim() : "",
      });
    }

    let filtered: ServiceRow[] = services;
    if (internal) filtered = filtered.filter(s => s.internalService);
    if (search) {
      filtered = rankServices(filtered, search);
    } else {
      filtered.sort((a, b) => a.name.localeCompare(b.name));
    }
    const cap = limit ?? (search ? 20 : undefined);
    const shown = cap ? filtered.slice(0, cap) : filtered;

    const rows = shown.map((s) => {
      if (fields.mode !== "default") return projectRow(s as unknown as Record<string, unknown>, fields, DEFAULT_FIELDS);
      return projectRow(
        {
          ...s,
          label: s.label !== s.name ? s.label : undefined,
          aliasNames: s.aliasNames.filter((a) => a !== s.name && a !== s.label),
          internalService: s.internalService || undefined,
          description: s.description ? abbreviate(s.description, 100) : undefined,
        },
        fields,
        DEFAULT_FIELDS,
      );
    });

    const filter: ServicesData["filter"] = {};
    if (internal) filter.internal = true;
    if (search) filter.search = search;
    return ok<ServicesData>({
      total: filtered.length,
      ...(internal || search ? { filter } : {}),
      services: rows,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ServicesData;
    ui.section(`Services (${data.services.length}${data.services.length < data.total ? ` of ${data.total}` : ""})`);
    if (data.services.length === 0) {
      ui.text("(none)");
      return;
    }
    const columns: string[] = [];
    for (const r of data.services) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
    const cell = (v: unknown) => (v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v));
    ui.table(columns, data.services.map((r) => columns.map((c) => cell(r[c]))));
  },
};

export default command;
