import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface ExportCategoryArgs {
  id: string | number;
  outPath?: string;
}

interface ExportCategoryData {
  id: string | number;
  writtenTo: string | null;
  bytes: number;
  preview: unknown;
}

export const args = defineArgs({
  command: "belz ad export-category",
  positionals: [{ name: "category-id", required: true, missingCode: "MISSING_CATEGORY_ID", missingMessage: "Missing category id argument." }],
  flags: { ...AD_COMMON_FLAGS, out: { type: "string" } },
});

const command: CommandModule<ExportCategoryArgs, ExportCategoryData> = {
  schema: "ad.export-category",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "export", "export-category");
    return { id: positionals.categoryId, outPath: flags.out };
  },
  async execute({ id, outPath }) {
    const body = await adApi.exportCategory(id);
    const serialised = JSON.stringify(body, null, 2);
    let written: string | null = null;
    if (outPath) {
      await Bun.write(outPath, serialised);
      written = outPath;
    }
    return ok<ExportCategoryData>({ id, writtenTo: written, bytes: serialised.length, preview: body });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ExportCategoryData;
    if (data.writtenTo) ui.success(`Wrote ${data.bytes} bytes to ${data.writtenTo}`);
    else ui.object(data.preview);
  },
};

export default command;
