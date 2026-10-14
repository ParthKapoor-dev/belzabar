import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { fetchCategories, requireChainCategory, type Category } from "../../lib/categories";

interface ExportCategoryArgs {
  ref: string;
  outPath?: string;
  full: boolean;
}

interface ExportCategoryData {
  /** Chain-category id actually exported. */
  id: number;
  category: Category;
  methodCount: number;
  writtenTo?: string;
  bytes: number;
  /** The export body — omitted when written to --out unless --full. */
  preview?: unknown;
}

export const args = defineArgs({
  command: "wi-impl ad export-category",
  positionals: [{ name: "category", required: true, missingCode: "MISSING_CATEGORY_ID", missingMessage: "Missing category (name, uuid or id) argument." }],
  flags: { out: { type: "string" }, full: { type: "boolean" } },
});

const command: CommandModule<ExportCategoryArgs, ExportCategoryData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { ref: positionals.category, outPath: flags.out, full: flags.full };
  },
  async execute({ ref, outPath, full }, context) {
    // resolve name / uuid / system id to the chain-category id the
    // export endpoint needs (the system id 1318 exported an empty list).
    const category = requireChainCategory(await fetchCategories(), ref);
    const id = category.chainCategoryId;
    const body = await adApi.exportCategory(id);
    const methodCount = Array.isArray((body as { chainDefinitions?: unknown })?.chainDefinitions)
      ? (body as { chainDefinitions: unknown[] }).chainDefinitions.length
      : 0;
    if (methodCount === 0) context.warn(`Category '${category.name}' (id ${id}) exported no methods.`);
    const serialised = JSON.stringify(body, null, 2);
    let written: string | null = null;
    if (outPath) {
      await Bun.write(outPath, serialised);
      written = outPath;
    }
    return ok<ExportCategoryData>({
      id,
      category,
      methodCount,
      ...(written ? { writtenTo: written } : {}),
      bytes: serialised.length,
      ...(written && !full ? {} : { preview: body }),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ExportCategoryData;
    if (data.writtenTo) ui.success(`Wrote ${data.methodCount} method(s) of '${data.category.name}' (${data.bytes} bytes) to ${data.writtenTo}`);
    else ui.object(data.preview);
  },
};

export default command;
