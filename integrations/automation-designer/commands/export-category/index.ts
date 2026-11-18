import { CliError, defineArgs, isObj, lifecycle, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { pool } from "../../lib/callers";
import { fetchCategories, requireChainCategory, type Category } from "../../lib/categories";
import { loadOrBuildMethodFinderIndex } from "../../lib/method-finder";

interface ExportCategoryArgs {
  ref: string;
  outPath?: string;
  full: boolean;
  allowPartial: boolean;
}

/** A method the export left out. */
interface FailedExport {
  /** The server's failed chain id, or the method's uuid (per-method fallback). */
  id: string;
  name?: string;
  error?: string;
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
  /** --allow-partial: some methods could not be exported (listed in `failed`). */
  partial?: true;
  /** `per-method`: the category export failed as a whole, so each method was exported on its own. */
  mode?: "category" | "per-method";
  failed?: FailedExport[];
}

export const args = defineArgs({
  command: "wi-impl ad export-category",
  positionals: [{ name: "category", required: true, missingCode: "MISSING_CATEGORY_ID", missingMessage: "Missing category (name, uuid or id) argument." }],
  flags: { out: { type: "string" }, full: { type: "boolean" }, "allow-partial": { type: "boolean" } },
});

/**
 * Export each method of the category on its own (the per-method route), when the category
 * export fails as a whole. Methods come from the method index; a failed one is listed.
 */
async function exportMethodByMethod(category: Category): Promise<{ body: { chainDefinitions: unknown[] }; failed: FailedExport[] }> {
  const { index } = await loadOrBuildMethodFinderIndex({ refresh: true });
  const methods = index.methods.filter((m) => m.categoryName.toLowerCase() === category.name.toLowerCase());
  const chainDefinitions: unknown[] = [];
  const failed: FailedExport[] = [];
  let done = 0;
  await pool(methods, async (m) => {
    try {
      const raw = (await adApi.fetchRawMethod(m.uuid, "v1")) as { id?: unknown };
      if (typeof raw.id !== "number") throw new Error("no numeric chain id on the V1 record");
      const one = await adApi.exportMethod(raw.id);
      if (!isObj(one)) throw new Error("empty export");
      chainDefinitions.push(one);
    } catch (e) {
      failed.push({ id: m.uuid, name: m.methodName, error: e instanceof Error ? e.message : String(e) });
    }
    if (++done % 25 === 0 || done === methods.length) lifecycle.notice(`Exporting methods one by one: ${done}/${methods.length}`);
  });
  return { body: { chainDefinitions }, failed };
}

const command: CommandModule<ExportCategoryArgs, ExportCategoryData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { ref: positionals.category, outPath: flags.out, full: flags.full, allowPartial: flags.allowPartial };
  },
  async execute({ ref, outPath, full, allowPartial }, context) {
    // resolve name / uuid / system id to the chain-category id the
    // export endpoint needs (the system id 1318 exported an empty list).
    const category = requireChainCategory(await fetchCategories(), ref);
    const id = category.chainCategoryId;
    let body: unknown;
    let failed: FailedExport[] = [];
    let mode: ExportCategoryData["mode"] = "category";
    try {
      body = await adApi.exportCategory(id, { allowPartial });
    } catch (e) {
      // One unexportable method (e.g. a step naming a deleted automation) fails the whole
      // category export; --allow-partial exports the others one by one.
      if (!allowPartial || !(e instanceof CliError) || e.code !== "AD_API_ERROR") throw e;
      context.warn(`The category export failed (${e.message}); exporting its methods one by one.`);
      ({ body, failed } = await exportMethodByMethod(category));
      mode = "per-method";
    }
    const serverFailed = isObj(body) && Array.isArray(body.failedChainIds) ? body.failedChainIds : [];
    failed.push(...serverFailed.map((f) => ({ id: String(isObj(f) ? (f.id ?? f.uuid ?? JSON.stringify(f)) : f) })));
    const methodCount = Array.isArray((body as { chainDefinitions?: unknown })?.chainDefinitions)
      ? (body as { chainDefinitions: unknown[] }).chainDefinitions.length
      : 0;
    if (methodCount === 0) context.warn(`Category '${category.name}' (id ${id}) exported no methods.`);
    if (failed.length) context.warn(`${failed.length} method(s) could not be exported: ${failed.map((f) => f.name ?? f.id).slice(0, 10).join(", ")}${failed.length > 10 ? ", …" : ""}.`);
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
      ...(allowPartial ? { mode } : {}),
      ...(failed.length ? { partial: true as const, failed } : {}),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ExportCategoryData;
    if (data.writtenTo) ui.success(`Wrote ${data.methodCount} method(s) of '${data.category.name}' (${data.bytes} bytes) to ${data.writtenTo}`);
    else ui.object(data.preview);
    for (const f of data.failed ?? []) ui.warn(`Not exported: ${f.name ? `${f.name} (${f.id})` : f.id}${f.error ? `: ${f.error}` : ""}`);
  },
};

export default command;
