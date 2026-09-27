import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { fetchCategories, type Category } from "../../lib/categories";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface CategoriesArgs {
  system: boolean;
  user: boolean;
}

/** `id` is the chain-category id other commands consume (null for system services). */
interface CategoryRow extends Category {
  id: number | null;
  uuid: string | null;
}

interface CategoriesData {
  total: number;
  filter: "all" | "system" | "user";
  categories: CategoryRow[];
}

export const args = defineArgs({
  command: "belz ad categories",
  flags: {
    ...AD_COMMON_FLAGS,
    user: { type: "boolean" },
    system: { type: "boolean" },
  },
  // F34: the two filters contradict each other.
  exclusive: [["user", "system"]],
});

const command: CommandModule<CategoriesArgs, CategoriesData> = {
  schema: "ad.categories",
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    resolveAdCommon(flags, "category", "categories");
    return { system: flags.system, user: flags.user };
  },
  async execute({ system, user }) {
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

    return ok<CategoriesData>({ total: filtered.length, filter, categories: filtered });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as CategoriesData;
    ui.section(`Categories (${data.filter}, ${data.total})`);
    if (data.categories.length === 0) ui.text("(none)");
    else ui.table(
      ["Name", "Type", "ID", "UUID", "System ID", "System UUID"],
      data.categories.map(c => [c.name, c.type, c.id ?? "-", c.uuid ?? "", c.systemId ?? "-", c.systemUuid ?? ""]),
    );
  },
};

export default command;
