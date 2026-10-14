import { CliError, currentCacheEnv, defineArgs, ok, type CommandModule } from "@belzabar/core";
import * as v2 from "../../lib/api/v2";
import { AD_YES_FLAG } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { normalizeUuid } from "@belzabar/core/platform";
import { markMethodIndexDirty } from "@belzabar/core/platform";
import { addMethodToIndex } from "../../lib/method-finder";
import { createTestValueNote } from "../../lib/save/test-values";
import { postChainV2 } from "../../lib/save/api";
import { VALIDATION_FLAGS } from "../../lib/save/flags";
import { expandSpec, readSpecFile } from "../../lib/save/spec";
import { dryRunValidation, verifyStructural, versionName, type DryRunValidation } from "../../lib/save/pipeline";
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
  command: "wi-impl ad create",
  flags: {
    ...AD_YES_FLAG,
    ...VALIDATION_FLAGS,
    category: { type: "string", description: "Target category (or spec.category)" },
    spec: { type: "string", required: true, missingCode: "MISSING_SPEC", missingMessage: "--spec <file> is required (a compact spec, or a V2 method body or subset)." },
    "dry-run": { type: "boolean", description: "Expand + validate only; print the V2 body, create nothing" },
  },
});

const command: CommandModule<CreateArgs, CreateData | CreateDryRunData> = {
  // --dry-run-compile POSTs the executing /chain/test route (steps gated
  // off), so even a dry run with it must name --env explicitly.
  writes: (a) => !a.dryRun || a.dryRunCompile,
  requiresEnv: true, // --dry-run reads the target env (category, callee contracts): never the default silently
  parseArgs(argv) {
    const { flags } = args.parse(argv);
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
    const spec = await readSpecFile(a.specPath);
    const { body, dropped, category } = await expandSpec(spec, a.category);
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
    await markMethodIndexDirty(currentCacheEnv(), uuid); // `ad callers` reads it before the next index build
    if (!uuid) {
      throw new CliError("Create answered without a uuid; check the category in the AD UI.", {
        code: "AD_SAVE_INVALID_RESPONSE",
        details: { name: body.name },
      });
    }

    // `find` lists it at once, without an index rebuild.
    if (category.chainCategoryUuid) {
      await addMethodToIndex(currentCacheEnv(), {
        uuid,
        name: String(body.name),
        categoryUuid: category.chainCategoryUuid,
        categoryName: category.name,
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
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

    // A new draft has no stored testValues, which the designer's Test dialog needs for required inputs.
    const requiredInputs = (back.inputs ?? []).filter((f) => f.required === true && typeof f.key === "string").map((f) => f.key);
    if (requiredInputs.length > 0) context.warn(createTestValueNote(requiredInputs));

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
