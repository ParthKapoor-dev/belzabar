import { ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

interface CategoriesArgs {
  system: boolean;
  user: boolean;
}

interface CategoryRow {
  id: number | string;
  uuid: string;
  name: string;
  type: "USER_GENERATED" | "SYSTEM_GENERATED" | string;
}

interface CategoriesData {
  total: number;
  filter: "all" | "system" | "user";
  categories: CategoryRow[];
}

const command: CommandModule<CategoriesArgs, CategoriesData> = {
  schema: "ad.categories",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "category", "categories");
    emitFallbackWarning(common, "categories");
    return {
      system: rest.includes("--system"),
      user: rest.includes("--user"),
    };
  },
  async execute({ system, user }) {
    const raw = (await adApi.listCategories({ includeSystem: true })) as unknown;
    const arr = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.categories) ? (raw as any).categories : [];

    const categories: CategoryRow[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.id === "number" || typeof r.id === "string" ? r.id : (r.automationChainCategoryId as number | string | undefined);
      const uuid = typeof r.uuid === "string" ? r.uuid : "";
      const name = typeof r.name === "string" ? r.name : typeof r.label === "string" ? (r.label as string) : "";
      const type = typeof r.type === "string" ? (r.type as string) : "";
      if (!name) continue;
      categories.push({ id: id ?? "", uuid, name, type });
    }

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
      ["Name", "Type", "ID", "UUID"],
      data.categories.map(c => [c.name, c.type, String(c.id), c.uuid]),
    );
  },
};

export default command;
