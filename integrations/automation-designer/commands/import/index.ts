import { readFile } from "fs/promises";
import { CliError, currentCacheEnv, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { dropMethodIndex } from "../../lib/method-finder";

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new CliError(`${filePath} is not valid JSON: ${(err as Error).message}`, { code: "INVALID_JSON" });
    }
    // A saved `--llm` envelope carries the export body in data.preview.
    const payload = unwrapEnvelope(parsed);

    const methodNames = extractMethodNames(payload);
    if (methodNames.length === 0) {
      context.warn("No methods recognised in the file (expected the output of `belz ad export` / `export-category`).");
    }

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
    await dropMethodIndex(currentCacheEnv()); // ADR-R1: imported uuids are unknown, so rebuild the index

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

/**
 * One name per method in an import file. Understands belz's own export
 * shapes (F13): `ad export` → `{chainDefinition, testSuite}`,
 * `ad export-category` → `{chainDefinitions: [{chainDefinition, testSuite}]}`,
 * an `--llm` envelope around either (`data.preview`), plus plain method
 * records / lists (`methods`, `methodList`, arrays).
 */
export function extractMethodNames(payload: unknown): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== "object") return;
    const p = node as Record<string, unknown>;
    if (p.data && typeof p.data === "object" && "preview" in (p.data as object)) return visit((p.data as { preview: unknown }).preview);
    if (p.chainDefinition && typeof p.chainDefinition === "object") return visit(p.chainDefinition);
    for (const key of ["chainDefinitions", "methods", "methodList"]) {
      if (Array.isArray(p[key])) return visit(p[key]);
    }
    const name = methodName(p);
    if (name) names.push(name);
  };
  visit(payload);
  return names;
}

function unwrapEnvelope(v: unknown): unknown {
  const d = (v as { data?: { preview?: unknown } } | null)?.data;
  return d && typeof d === "object" && "preview" in d ? d.preview : v;
}

function methodName(p: Record<string, unknown>): string | null {
  for (const v of [p.name, p.aliasName]) if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof p.jsonDefinition === "string") {
    try {
      const inner = JSON.parse(p.jsonDefinition) as { name?: unknown };
      if (typeof inner.name === "string" && inner.name.trim()) return inner.name.trim();
    } catch {
      /* not JSON — no name */
    }
  }
  return null;
}

export default command;
