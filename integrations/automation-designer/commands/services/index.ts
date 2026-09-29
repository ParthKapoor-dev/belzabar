import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { normalizeUuid } from "@belzabar/core/platform";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { abbreviate, parseFieldList, projectRow, type FieldSelection } from "../../lib/compact";
import { scoreFuzzy } from "../../lib/method-finder";

interface ServicesArgs {
  /** `ad services <SERVICE>`: list that service's methods instead. */
  service?: string;
  all: boolean;
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

/** One method of a service (CLI trial: agents guessed method names and hit 404s). */
export interface ServiceMethodRow {
  /** The name `Svc/method` compact steps and `ad child-info` take (the API uri). */
  method: string;
  /** UI label, when it differs (db_service: data.read …; compact steps accept it too). */
  label?: string;
  /** automationAPIId other methods' steps reference. */
  apiUuid: string | null;
  state?: string;
  hidden?: true;
  inactive?: true;
  deprecated?: true;
  score?: number;
}

interface ServiceMethodsData {
  service: string;
  total: number;
  methods: ServiceMethodRow[];
}

/** Rows from `GET /automation-systems/{svc}/automation-apis` (hidden / inactive / deprecated dropped unless `all`). */
export function serviceMethodRows(body: unknown, all: boolean): ServiceMethodRow[] {
  const rows: ServiceMethodRow[] = [];
  for (const a of Array.isArray(body) ? body : []) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const method = typeof r.uri === "string" ? r.uri : "";
    if (!method) continue;
    const hidden = r.hideOnUi === true;
    const inactive = r.active === false;
    const deprecated = r.methodDeprecated === true;
    if (!all && (hidden || inactive || deprecated)) continue;
    const label = typeof r.label === "string" && r.label !== method ? r.label : undefined;
    rows.push({
      method,
      ...(label ? { label } : {}),
      apiUuid: normalizeUuid(r.uuid),
      ...(typeof r.state === "string" && r.state ? { state: r.state } : {}),
      ...(hidden ? { hidden: true as const } : {}),
      ...(inactive ? { inactive: true as const } : {}),
      ...(deprecated ? { deprecated: true as const } : {}),
    });
  }
  return rows.sort((a, b) => a.method.localeCompare(b.method));
}

// 7.9: compact rows by default (label / aliases only when they differ from the
// name, description cut at 100 chars, empties dropped); --fields picks, --fields all = full rows.
export const SERVICE_FIELDS = ["name", "id", "uuid", "systemUuid", "label", "type", "internalService", "aliasNames", "description", "score"] as const;
const DEFAULT_FIELDS = ["name", "id", "type", "internalService", "label", "aliasNames", "description", "score"];

export const args = defineArgs({
  command: "belz ad services",
  positionals: [{ name: "service" }],
  flags: {
    all: { type: "boolean" },
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

const command: CommandModule<ServicesArgs, ServicesData | ServiceMethodsData> = {
  schema: "ad.services",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "list", "services");
    const service = positionals.service?.trim() || undefined;
    if (service && (flags.internal || flags.fields !== undefined)) {
      throw new CliError("--internal and --fields apply to the service list, not to one service's methods.", { code: "INVALID_ARGUMENT" });
    }
    if (flags.all && !service) throw new CliError("--all applies with a <SERVICE> (its hidden / inactive methods).", { code: "INVALID_ARGUMENT" });
    return { ...(service ? { service } : {}), all: flags.all, internal: flags.internal, search: flags.search, limit: flags.limit, fields: parseFieldList(flags.fields, SERVICE_FIELDS) };
  },
  async execute({ service, all, internal, search, limit, fields }, context) {
    if (service) {
      let methods = serviceMethodRows(await adApi.listServiceMethods(service), all);
      if (methods.length === 0) {
        context.warn(
          `No ${all ? "" : "visible "}methods for service '${service}': an unknown service name (see \`belz ad services --search\`), or a user category whose methods are not published (see \`belz ad find\` with a category).`,
        );
      }
      if (search) {
        methods = methods
          .map((m) => ({ ...m, score: Math.max(scoreFuzzy(search, m.method, 1), m.label ? scoreFuzzy(search, m.label, 0.95) : 0) }))
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score || a.method.localeCompare(b.method));
      }
      const total = methods.length;
      return ok<ServiceMethodsData>({ service, total, methods: limit ? methods.slice(0, limit) : methods });
    }
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
    if (envelope.data && "methods" in (envelope.data as object)) {
      const d = envelope.data as ServiceMethodsData;
      ui.section(`${d.service} methods (${d.methods.length}${d.methods.length < d.total ? ` of ${d.total}` : ""})`);
      if (d.methods.length === 0) ui.text("(none)");
      else ui.table(["method", "label", "apiUuid", "flags"], d.methods.map((m) => [m.method, m.label ?? "", m.apiUuid ?? "", [m.state, m.hidden && "hidden", m.inactive && "inactive", m.deprecated && "deprecated"].filter(Boolean).join(" ")]));
      ui.text(`Tip: belz ad child-info ${d.service} <method> --shape  (inputs/outputs to wire a step)`);
      return;
    }
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
