import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface ExportArgs {
  id: string | number;
  outPath?: string;
}

interface ExportData {
  id: string | number;
  writtenTo: string | null;
  bytes: number;
  preview: unknown;
}

export const args = defineArgs({
  command: "belz ad export",
  positionals: [{ name: "method-id", required: true, missingCode: "MISSING_METHOD_ID", missingMessage: "Missing method id (numeric) or UUID argument." }],
  flags: { ...AD_COMMON_FLAGS, out: { type: "string" } },
});

const command: CommandModule<ExportArgs, ExportData> = {
  schema: "ad.export",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "export", "export");
    return { id: positionals.methodId, outPath: flags.out };
  },
  async execute({ id, outPath }) {
    const body = await adApi.exportMethod(id);
    const serialised = JSON.stringify(body, null, 2);
    let written: string | null = null;
    if (outPath) {
      await Bun.write(outPath, serialised);
      written = outPath;
    }
    return ok<ExportData>({
      id,
      writtenTo: written,
      bytes: serialised.length,
      preview: body,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ExportData;
    if (data.writtenTo) {
      ui.success(`Wrote ${data.bytes} bytes to ${data.writtenTo}`);
    } else {
      ui.section(`Method export (${data.bytes} bytes)`);
      ui.object(data.preview);
    }
  },
};

export default command;
