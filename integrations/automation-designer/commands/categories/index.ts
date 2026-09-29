import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { fetchCategories, type Category } from "../../lib/categories";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { parseFieldList, projectRow } from "../../lib/compact";

interface CategoriesArgs {
  system: boolean;
  user: boolean;
  /** Raw `--fields` value (validated in parseArgs). */
  fields?: string;
}

/** `id` is the chain-category id other commands consume (null for system services). */
interface CategoryRow extends Category {
  id: number | null;
  uuid: string | null;
}

interface CategoriesData {
  total: number;
  filter: "all" | "system" | "user";
  categories: Array<Record<string, unknown>>;
}

// 7.9: `id`/`uuid` already are the chain-category id/uuid, so the default row
// drops the chainCategoryId/chainCategoryUuid duplicates (and systemUuid,
// label); `--fields a,b` picks, `--fields all` = the full row.
export const CATEGORY_FIELDS = ["id", "uuid", "name", "type", "systemId", "systemUuid", "chainCategoryId", "chainCategoryUuid", "label"] as const;
const DEFAULT_FIELDS = ["id", "uuid", "name", "type", "systemId"];

export const args = defineArgs({
  command: "belz ad categories",
  flags: {
    ...AD_COMMON_FLAGS,
    user: { type: "boolean" },
    system: { type: "boolean" },
    fields: { type: "string" },
  },
  // F34: the two filters contradict each other.
  exclusive: [["user", "system"]],
});

const command: CommandModule<CategoriesArgs, CategoriesData> = {
  schema: "ad.categories",
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    resolveAdCommon(flags, "category", "categories");
    parseFieldList(flags.fields, CATEGORY_FIELDS);
    return { system: flags.system, user: flags.user, ...(flags.fields !== undefined ? { fields: flags.fields } : {}) };
  },
  async execute({ system, user, fields }) {
    const sel = parseFieldList(fields, CATEGORY_FIELDS);
    // AD-09/F9: chain categories (id 1135 = what methods, POST /chain and
    // export-category use), joined with their automation system (1318).
    const categories: CategoryRow[] = (await fetchCategories()).map((c) => ({
      id: c.chainCategoryId,
      uuid: c.chainCategoryUuid ?? c.systemUuid,
      ...c,
    }));

    let filtered = categories;
    let filter: CategoriesData["filter"] = "all";
    if (system && !user) {
      filter = "system";
      filtered = categories.filter(c => c.type === "SYSTEM_GENERATED");
    } else if (user && !system) {
      filter = "user";
      filtered = categories.filter(c => c.type === "USER_GENERATED");
    }

    filtered.sort((a, b) => a.name.localeCompare(b.name));

    return ok<CategoriesData>({
      total: filtered.length,
      filter,
      categories: filtered.map((c) => projectRow(c as unknown as Record<string, unknown>, sel, DEFAULT_FIELDS)),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as CategoriesData;
    ui.section(`Categories (${data.filter}, ${data.total})`);
    if (data.categories.length === 0) ui.text("(none)");
    else {
      const columns: string[] = [];
      for (const r of data.categories) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
      ui.table(columns, data.categories.map((r) => columns.map((c) => (r[c] === undefined || r[c] === null ? "-" : String(r[c])))));
    }
  },
};

export default command;
