import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";

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

const command: CommandModule<ExportArgs, ExportData> = {
  schema: "ad.export",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "export", "export");
    emitFallbackWarning(common, "export");
    const first = rest[0];
    if (!first || first.startsWith("-")) {
      throw new CliError("Missing method id (numeric) or UUID argument.", {
        code: "MISSING_METHOD_ID",
      });
    }
    const outIdx = rest.indexOf("--out");
    return {
      id: first,
      outPath: outIdx !== -1 ? rest[outIdx + 1] : undefined,
    };
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
