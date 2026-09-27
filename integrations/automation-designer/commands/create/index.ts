import { readFile } from "fs/promises";
import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import * as v2 from "../../lib/api/v2";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { fetchCategories, requireChainCategory } from "../../lib/categories";
import { normalizeUuid } from "../../lib/ids";
import { postChainV2 } from "../../lib/save/api";
import { assertCreatableCategory, buildCreateBody } from "../../lib/save/create";
import { VALIDATION_FLAGS } from "../../lib/save/flags";
import { versionName } from "../../lib/save/pipeline";
import { runValidationGate, type ValidationSummary } from "../../lib/save/validation";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

interface CreateArgs {
  category: string;
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

export const args = defineArgs({
  command: "belz ad create",
  flags: {
    ...AD_COMMON_FLAGS,
    ...AD_YES_FLAG,
    ...VALIDATION_FLAGS,
    category: { type: "string", required: true, missingCode: "MISSING_CATEGORY", missingMessage: "--category <name|id|uuid> is required." },
    spec: { type: "string", required: true, missingCode: "MISSING_SPEC", missingMessage: "--spec <file> is required (a V2 method body or subset)." },
  },
});

const command: CommandModule<CreateArgs, CreateData> = {
  schema: "ad.create",
  writes: true,
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    resolveAdCommon(flags, "save", "create");
    return {
      category: flags.category,
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

    const category = requireChainCategory(await fetchCategories(), a.category);
    assertCreatableCategory(category);
    const { body, dropped } = buildCreateBody(spec, category);
    if (dropped.length > 0) context.warn(`Dropped server-owned spec key(s): ${dropped.join(", ")}.`);

    const validation = await runValidationGate(
      { noValidate: a.noValidate, strict: a.strict, dryRunCompile: a.dryRunCompile },
      { after: body as V2MethodResponse, env: context.env.name, action: "create", warn: (m) => context.warn(m) },
    );

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

    return ok<CreateData>({
      uuid,
      name: String(back.name),
      state: back.metadata?.state ?? null,
      version: versionName(back),
      category: { chainCategoryId: category.chainCategoryId, chainCategoryUuid: category.chainCategoryUuid, name: category.name },
      stepCount: (back.steps ?? []).length,
      dropped,
      validation,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
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
