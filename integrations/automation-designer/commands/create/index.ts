import { readFile } from "fs/promises";
import { dirname } from "path";
import { CliError, currentCacheEnv, defineArgs, ok, type CommandModule } from "@belzabar/core";
import * as v2 from "../../lib/api/v2";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { fetchCategories, requireChainCategory } from "../../lib/categories";
import { normalizeUuid } from "../../lib/ids";
import { invalidateMethodIndexEntry } from "../../lib/method-finder";
import { postChainV2 } from "../../lib/save/api";
import { assertCreatableCategory, buildCreateBody, compactSteps } from "../../lib/save/create";
import { VALIDATION_FLAGS } from "../../lib/save/flags";
import { dryRunValidation, verifyStructural, versionName, type DryRunValidation } from "../../lib/save/pipeline";
import { loadServiceCatalog, servicesOfCompactSteps } from "../../lib/save/services";
import { resolveSpecSources } from "../../lib/save/sources";
import { runValidationGate, type ValidationSummary } from "../../lib/save/validation";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

interface CreateArgs {
  category: string | null;
  dryRun: boolean;
  specPath: string;
  yes: boolean;
  noValidate: boolean;
  strict: boolean;
  dryRunCompile: boolean;
}

interface CreateData {
  uuid: string;
  name: string;
  state: string | null;
  version: string | null;
  category: { chainCategoryId: number; chainCategoryUuid: string | null; name: string };
  stepCount: number;
  /** Spec keys dropped because the server owns them. */
  dropped: string[];
  validation: ValidationSummary;
}

interface CreateDryRunData {
  dryRun: true;
  /** No blocking validator findings (the create would pass the gate). */
  valid: boolean;
  category: { chainCategoryId: number; chainCategoryUuid: string | null; name: string };
  dropped: string[];
  validation: DryRunValidation;
  /** The expanded V2 body that would be POSTed. */
  body: Record<string, unknown>;
}

export const args = defineArgs({
  command: "belz ad create",
  flags: {
    ...AD_COMMON_FLAGS,
    ...AD_YES_FLAG,
    ...VALIDATION_FLAGS,
    category: { type: "string", description: "Target category (or spec.category)" },
    spec: { type: "string", required: true, missingCode: "MISSING_SPEC", missingMessage: "--spec <file> is required (a compact spec, or a V2 method body or subset)." },
    "dry-run": { type: "boolean", description: "Expand + validate only; print the V2 body, create nothing" },
  },
});

const command: CommandModule<CreateArgs, CreateData | CreateDryRunData> = {
  schema: "ad.create",
  writes: (a) => !a.dryRun,
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    resolveAdCommon(flags, "save", "create");
    return {
      category: flags.category ?? null,
      dryRun: flags.dryRun,
      specPath: flags.spec,
      yes: flags.yes,
      noValidate: flags.noValidate,
      strict: flags.strict,
      dryRunCompile: flags.dryRunCompile,
    };
  },
  async execute(a, context) {
    let spec: unknown;
    try {
      spec = JSON.parse(await readFile(a.specPath, "utf-8"));
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      throw new CliError(`${missing ? "Cannot read" : "Invalid JSON in"} spec file ${a.specPath}: ${String(err)}`, {
        code: missing ? "FILE_NOT_FOUND" : "INVALID_JSON",
      });
    }

    await resolveSpecSources(spec, dirname(a.specPath));
    const specCategory = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>).category : undefined;
    if (specCategory !== undefined && typeof specCategory !== "string" && typeof specCategory !== "number") {
      throw new CliError("spec.category must be a category name, id or uuid.", { code: "AD_SPEC_INVALID", details: { path: "category" } });
    }
    const categoryRef = a.category ?? (specCategory === undefined ? null : String(specCategory));
    if (!categoryRef) {
      throw new CliError("--category <name|id|uuid> is required (or set category in the spec).", { code: "MISSING_CATEGORY" });
    }
    const categories = await fetchCategories();
    const category = requireChainCategory(categories, categoryRef);
    if (a.category && specCategory !== undefined && requireChainCategory(categories, String(specCategory)).chainCategoryId !== category.chainCategoryId) {
      throw new CliError(`--category ${a.category} and spec.category ${String(specCategory)} name different categories.`, {
        code: "AD_SPEC_INVALID",
        details: { flag: a.category, spec: specCategory },
      });
    }
    assertCreatableCategory(category);
    const catalog = await loadServiceCatalog(servicesOfCompactSteps(compactSteps(spec)));
    const { body, dropped } = buildCreateBody(spec, category, catalog);
    if (dropped.length > 0) context.warn(`Dropped server-owned spec key(s): ${dropped.join(", ")}.`);
    const flags = { noValidate: a.noValidate, strict: a.strict, dryRunCompile: a.dryRunCompile };
    const gate = { after: body as V2MethodResponse, env: context.env.name, action: "create", warn: (m: string) => context.warn(m) };
    const categoryData = { chainCategoryId: category.chainCategoryId, chainCategoryUuid: category.chainCategoryUuid, name: category.name };

    if (a.dryRun) {
      const validation = await dryRunValidation(() => runValidationGate(flags, gate));
      return ok<CreateDryRunData>({ dryRun: true, valid: validation.errors.length === 0, category: categoryData, dropped, validation, body });
    }

    const validation = await runValidationGate(flags, gate);

    const steps = body.steps as unknown[];
    await requireConfirmation({
      yes: a.yes,
      outputMode: context.outputMode,
      action: `create method ${String(body.name)} in ${category.name}`,
      details: [
        ["Name", String(body.name)],
        ["Category", `${category.name} (chain category ${category.chainCategoryId})`],
        ["Steps", String(steps.length)],
        ["Validation", validation.skipped ? "SKIPPED (--no-validate)" : `${validation.warnings.length} warning(s)`],
      ],
    });

    logIntent("POST", "/rest/api/automation/chain/v2", { create: body.name, category: category.chainCategoryId });
    let created: V2MethodResponse;
    try {
      created = await postChainV2(body);
    } catch (err) {
      const d = err instanceof CliError ? (err.details as { body?: { data?: unknown } } | undefined) : undefined;
      if (typeof d?.body?.data === "string" && d.body.data.includes("duplicate_method_name")) {
        throw new CliError(`A method or alias named '${String(body.name)}' already exists in ${category.name}.`, {
          code: "AD_METHOD_EXISTS",
          details: { name: body.name, category: category.name },
        });
      }
      throw err;
    }
    const uuid = normalizeUuid(created.uuid);
    await invalidateMethodIndexEntry(currentCacheEnv(), uuid); // ADR-R1: `ad callers` reads it before the next index build
    if (!uuid) {
      throw new CliError("Create answered without a uuid; check the category in the AD UI.", {
        code: "AD_SAVE_INVALID_RESPONSE",
        details: { name: body.name },
      });
    }

    // Verify: the method reads back as a DRAFT with this name, in this category.
    const back = await v2.fetchRawMethod(uuid);
    const problems: string[] = [];
    if (back.name !== body.name) problems.push(`name is ${JSON.stringify(back.name)}`);
    if (back.metadata?.state !== "DRAFT") problems.push(`state is ${String(back.metadata?.state)}`);
    if (back.metadata?.service?.id !== category.chainCategoryId) problems.push(`category id is ${String(back.metadata?.service?.id)}`);
    if ((back.steps ?? []).length !== steps.length) problems.push(`${(back.steps ?? []).length} steps stored, ${steps.length} sent`);
    if (problems.length > 0) {
      throw new CliError(`Created ${uuid}, but it reads back differently: ${problems.join("; ")}.`, {
        code: "AD_SAVE_VERIFY_FAILED",
        details: { uuid, problems },
      });
    }
    // Every value sent must read back (the server only adds ids, uuids and defaults).
    verifyStructural(uuid, body, back, [""]);

    return ok<CreateData>({
      uuid,
      name: String(back.name),
      state: back.metadata?.state ?? null,
      version: versionName(back),
      category: categoryData,
      stepCount: (back.steps ?? []).length,
      dropped,
      validation,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    if ((envelope.data as CreateDryRunData).dryRun) {
      const d = envelope.data as CreateDryRunData;
      ui.info(JSON.stringify(d.body, null, 2));
      const line = `Dry run: ${d.valid ? "valid" : `${d.validation.errors.length} blocking finding(s)`}, ${d.validation.warnings.length} warning(s); nothing created`;
      if (d.valid) ui.success(line);
      else ui.warn(line);
      for (const f of d.validation.errors) ui.warn(`${f.rule} ${f.path}: ${f.message}`);
      return;
    }
    const d = envelope.data as CreateData;
    ui.success(`Created draft ${d.name}: ${d.uuid}`);
    ui.table(
      ["Property", "Value"],
      [
        ["UUID", d.uuid],
        ["Category", `${d.category.name} (${d.category.chainCategoryId})`],
        ["State / version", `${d.state ?? "?"} v${d.version ?? "?"}`],
        ["Steps", String(d.stepCount)],
        ["Validation", d.validation.skipped ? "SKIPPED" : `${d.validation.warnings.length} warning(s)`],
      ],
    );
  },
};

export default command;
