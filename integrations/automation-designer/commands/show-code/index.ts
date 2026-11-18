import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { resolveMethodRef } from "@belzabar/core/platform";
import { AD_V2_FLAG, apiVersionOf } from "../../lib/args/common";
import type { CustomCodeStep, HydratedMethod } from "../../lib/types/common";
import { identityForStep } from "../../lib/method-view";

interface ShowCodeArgs {
  uuid: string;
  step: number | null;
  outPath?: string;
  apiVersion: "v1" | "v2";
}

interface ShowCodeSnippet {
  orderIndex: number;
  description: string;
  language: string;
  source: string;
}

interface ShowCodeData {
  uuid: string;
  sourceVersion: "v1" | "v2";
  snippets: ShowCodeSnippet[];
  writtenTo?: string;
}

/**
 * NO_CUSTOM_CODE that says why (D7): a stepless method is a built-in service
 * (no source anywhere); otherwise it names the steps it has, so a service
 * call's code is looked up on the callee.
 */
function noCodeError(method: HydratedMethod): CliError {
  const steps = method.parsedSteps.map(s => `${s.orderIndex} ${s.kind}${identityForStep(s) ? ` ${identityForStep(s)}` : ""}`);
  if (steps.length === 0) {
    return new CliError(
      `'${method.name}' is a built-in service method: it has no steps, so there is no source to show. Its contract: 'wi-impl ad show ${method.uuid}'.`,
      { code: "NO_CUSTOM_CODE", details: { uuid: method.uuid, builtIn: true, steps: [] } },
    );
  }
  return new CliError(
    `'${method.name}' has no custom-code steps (steps: ${steps.join("; ")}). A called method's code is on the callee: 'wi-impl ad find <name>', then 'wi-impl ad show-code <its uuid>'.`,
    { code: "NO_CUSTOM_CODE", details: { uuid: method.uuid, builtIn: false, steps } },
  );
}

export const args = defineArgs({
  command: "wi-impl ad show-code",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {
    ...AD_V2_FLAG,
    step: { type: "number", integer: true, min: 1, alias: ["--service-detail"] },
    out: { type: "string" },
  },
});

const command: CommandModule<ShowCodeArgs, ShowCodeData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return {
      uuid: resolveMethodRef(positionals.uuid),
      step: flags.step ?? null,
      outPath: flags.out,
      apiVersion: apiVersionOf(flags),
    };
  },
  async execute({ uuid, step, outPath, apiVersion }) {
    const method = await adApi.fetchMethod(uuid, apiVersion);
    const codeSteps = method.parsedSteps.filter(
      (s): s is CustomCodeStep => s.kind === "CUSTOM_CODE",
    );

    const filtered = step !== null
      ? codeSteps.filter(s => s.orderIndex === step)
      : codeSteps;

    if (step !== null && filtered.length === 0) {
      throw new CliError(`No CUSTOM_CODE step at index ${step}.`, {
        code: "STEP_NOT_FOUND",
      });
    }
    if (codeSteps.length === 0) throw noCodeError(method);

    const snippets: ShowCodeSnippet[] = filtered.map(s => ({
      orderIndex: s.orderIndex,
      description: s.description ?? "",
      language: s.language ?? "",
      source: s.source,
    }));

    const data: ShowCodeData = {
      uuid,
      sourceVersion: method.sourceVersion,
      snippets,
    };

    if (outPath) {
      const body = snippets
        .map(sn => `// Step ${sn.orderIndex}: ${sn.description} [${sn.language}]\n${sn.source}`)
        .join("\n\n// ─────────────────────────────\n\n");
      await Bun.write(outPath, body);
      data.writtenTo = outPath;
    }

    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ShowCodeData;
    if (data.writtenTo) {
      ui.success(`Wrote ${data.snippets.length} snippet(s) to ${data.writtenTo}`);
      return;
    }
    for (const sn of data.snippets) {
      ui.section(`Step ${sn.orderIndex} — ${sn.language} — ${sn.description || "(no description)"}`);
      ui.text(sn.source);
    }
  },
};

export default command;
