import { CliError, type CommandModule, defineArgs, ok } from "@belzabar/core";
import { categories, dataSourcesOf, findCategory } from "../../lib/datasource";

interface DatasourcesArgs {
  category?: string;
  search?: string;
}

type DatasourcesData =
  | { kind: "categories"; total: number; categories: Array<{ name: string; uuid: string }> }
  | { kind: "datasources"; category: string; categoryUuid: string; total: number; datasources: Array<{ id: string; method: string; description: string | null }> };

export const args = defineArgs({
  command: "belz rd datasources",
  flags: {
    category: { type: "string" },
    search: { type: "string" },
  },
});

const command: CommandModule<DatasourcesArgs, DatasourcesData> = {
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    const category = flags.category?.trim();
    const search = flags.search?.trim().toLowerCase();
    return { ...(category ? { category } : {}), ...(search ? { search } : {}) };
  },
  async execute({ category, search }, context) {
    const match = (s: string) => !search || s.toLowerCase().includes(search);
    if (!category) {
      const all = (await categories()).filter((c) => match(c.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (!search) context.warn("Listing categories; pass --category <name> for its datasource methods (--search narrows either list).");
      return ok<DatasourcesData>({ kind: "categories", total: all.length, categories: all.map(({ name, uuid }) => ({ name, uuid })) });
    }
    const cat = await findCategory(category);
    if (!cat) {
      throw new CliError(`No datasource category '${category}' on ${context.env.name}.`, {
        code: "RD_DATASOURCE_CATEGORY_NOT_FOUND",
        details: { category },
      });
    }
    const rows = (await dataSourcesOf(cat.uuid)).filter((r) => match(r.method)).sort((a, b) => a.method.localeCompare(b.method));
    return ok<DatasourcesData>({ kind: "datasources", category: cat.name, categoryUuid: cat.uuid, total: rows.length, datasources: rows });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as DatasourcesData;
    if (d.kind === "categories") {
      ui.section(`Datasource categories (${d.total})`);
      ui.table(["Name", "UUID"], d.categories.map((c) => [c.name, c.uuid]));
      return;
    }
    ui.section(`Datasources in ${d.category} (${d.total})`);
    if (d.total === 0) ui.text("(none: only published methods are listed)");
    else ui.table(["Chain id", "Method", "Description"], d.datasources.map((r) => [r.id, r.method, (r.description ?? "").slice(0, 70)]));
  },
};

export default command;
