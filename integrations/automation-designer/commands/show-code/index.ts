import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import type { CustomCodeStep } from "../../lib/types/common";

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

export const args = defineArgs({
  command: "belz ad show-code",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: {
    ...AD_COMMON_FLAGS,
    step: { type: "number", integer: true, min: 1, alias: ["--service-detail"] },
    out: { type: "string" },
  },
});

const command: CommandModule<ShowCodeArgs, ShowCodeData> = {
  schema: "ad.show-code",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const common = resolveAdCommon(flags, "fetch", "show-code");
    return {
      uuid: positionals.uuid,
      step: flags.step ?? null,
      outPath: flags.out,
      apiVersion: common.apiVersion.version,
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
    if (codeSteps.length === 0) {
      throw new CliError(
        `Method has no CUSTOM_CODE steps. Use 'belz ad show <uuid>' to see step kinds.`,
        { code: "NO_CUSTOM_CODE" },
      );
    }

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
