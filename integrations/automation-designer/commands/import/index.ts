import { readFile } from "fs/promises";
import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";

interface ImportArgs {
  filePath: string;
  yes: boolean;
}

interface ImportData {
  filePath: string;
  response: unknown;
}

export const args = defineArgs({
  command: "belz ad import",
  positionals: [{ name: "file", required: true, missingCode: "MISSING_FILE", missingMessage: "Missing <file> argument." }],
  flags: { ...AD_COMMON_FLAGS, ...AD_YES_FLAG },
});

const command: CommandModule<ImportArgs, ImportData> = {
  schema: "ad.import",
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "import", "import");
    return { filePath: positionals.file, yes: flags.yes };
  },
  async execute({ filePath, yes }, context) {
    const text = await readFile(filePath, "utf-8");
    const payload = JSON.parse(text);

    const methodNames = extractMethodNames(payload);

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `import ${methodNames.length} method(s)`,
      details: [
        ["File", filePath],
        ["Methods (first 10)", methodNames.slice(0, 10).join(", ") || "(unknown)"],
        ["Total", String(methodNames.length)],
      ],
    });

    logIntent("POST", "/rest/api/automation/chain/import", { file: filePath, methodCount: methodNames.length });

    const response = await adApi.importMethods(payload);

    return ok<ImportData>({ filePath, response });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ImportData;
    ui.success(`Imported methods from ${data.filePath}`);
    ui.section("Response");
    ui.object(data.response);
  },
};

function extractMethodNames(payload: unknown): string[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.flatMap(extractMethodNames);
  if (typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const names: string[] = [];
  if (typeof p.name === "string") names.push(p.name);
  if (typeof p.aliasName === "string") names.push(p.aliasName);
  if (Array.isArray(p.methods)) names.push(...(p.methods as unknown[]).flatMap(extractMethodNames));
  if (Array.isArray(p.methodList)) names.push(...(p.methodList as unknown[]).flatMap(extractMethodNames));
  return [...new Set(names)];
}

export default command;
