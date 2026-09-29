import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { resolveMethodRef } from "@belzabar/core/platform";
import { adApi } from "../../lib/api/index";
import { extractMethodNames } from "../import/index";

interface ExportArgs {
  /** Numeric chain id, or a canonical method uuid (resolved to its chain id). */
  ref: { id: number } | { uuid: string };
  outPath?: string;
  full: boolean;
}

interface ExportData {
  /** Numeric chain id that was exported. */
  id: number;
  uuid: string | null;
  writtenTo?: string;
  bytes: number;
  /** Method name(s) in the export. */
  methods: string[];
  /**
   * The export body. 7.9: omitted when it was written to --out (the file has
   * it) unless --full; always present without --out (`ad import` reads it
   * from a saved --llm envelope).
   */
  preview?: unknown;
}

export const args = defineArgs({
  command: "belz ad export",
  positionals: [{ name: "method-id", required: true, missingCode: "MISSING_METHOD_ID", missingMessage: "Missing method id (numeric) or UUID argument." }],
  flags: { out: { type: "string" }, full: { type: "boolean" } },
});

const command: CommandModule<ExportArgs, ExportData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const input = positionals.methodId.trim();
    const ref = /^\d+$/.test(input) ? { id: Number(input) } : { uuid: resolveMethodRef(input) };
    return { ref, outPath: flags.out, full: flags.full };
  },
  async execute({ ref, outPath, full }) {
    // F12 / AD-31: the export endpoint only takes the numeric chain id.
    let id: number;
    let uuid: string | null = null;
    if ("id" in ref) id = ref.id;
    else {
      uuid = ref.uuid;
      const raw = await adApi.fetchRawMethod(uuid, "v1");
      if (typeof (raw as { id?: unknown }).id !== "number") {
        throw new CliError(`Method ${uuid} has no numeric chain id; cannot export it.`, { code: "METHOD_ID_UNKNOWN", details: { uuid } });
      }
      id = (raw as { id: number }).id;
    }
    const body = await adApi.exportMethod(id);
    if (body === null) {
      throw new CliError(`Method ${uuid ?? id} exported nothing (empty response).`, { code: "METHOD_NOT_FOUND", details: { id, uuid } });
    }
    const serialised = JSON.stringify(body, null, 2);
    let written: string | null = null;
    if (outPath) {
      await Bun.write(outPath, serialised);
      written = outPath;
    }
    return ok<ExportData>({
      id,
      uuid,
      ...(written ? { writtenTo: written } : {}),
      bytes: serialised.length,
      methods: extractMethodNames(body),
      ...(written && !full ? {} : { preview: body }),
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
