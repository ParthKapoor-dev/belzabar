import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
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

const command: CommandModule<ShowCodeArgs, ShowCodeData> = {
  schema: "ad.show-code",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "fetch", "show-code");
    emitFallbackWarning(common, "show-code");

    const first = rest[0];
    if (!first || first.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }

    const stepIdx = rest.indexOf("--step");
    const stepVal = stepIdx !== -1 ? rest[stepIdx + 1] : undefined;
    const step = stepVal !== undefined ? parseInt(stepVal, 10) : null;
    if (step !== null && Number.isNaN(step)) {
      throw new CliError("--step requires a numeric index.", { code: "INVALID_STEP_INDEX" });
    }

    const outIdx = rest.indexOf("--out");
    const outPath = outIdx !== -1 ? rest[outIdx + 1] : undefined;

    return {
      uuid: first,
      step,
      outPath,
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
