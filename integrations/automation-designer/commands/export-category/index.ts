import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

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

const command: CommandModule<ExportCategoryArgs, ExportCategoryData> = {
  schema: "ad.export-category",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "export", "export-category");
    emitFallbackWarning(common, "export-category");
    const first = rest[0];
    if (!first || first.startsWith("-")) {
      throw new CliError("Missing category id argument.", { code: "MISSING_CATEGORY_ID" });
    }
    const outIdx = rest.indexOf("--out");
    return { id: first, outPath: outIdx !== -1 ? rest[outIdx + 1] : undefined };
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
