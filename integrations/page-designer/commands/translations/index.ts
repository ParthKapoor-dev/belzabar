// belz pd translations — validate a published page/component's translation
// phrases via the page-dependencies API. Built for post-release validation.
//
//   belz pd translations <input> [--status PUBLISHED|DRAFT] [--expect-draft <id>]
//
// Resolves <input> to its draft + published ids, fetches page-dependencies for
// the published id, and checks: every *__translated_phrases entry key is
// page./symbol.<id>, and the main entity's phrase keys embed its draft id.
// Style/asset components with no translatable text return verdict N/A.

import { CliError, ok, type CommandModule } from "@belzabar/core";
import { parsePdCommonArgs } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import {
  resolveEntityIds,
  validateTranslationPhrases,
  type TranslationCheckResult,
} from "../../lib/page-dependencies";

type DepStatus = "PUBLISHED" | "DRAFT";

interface TranslationsArgs {
  input: string;
  status: DepStatus;
  expectDraft: string | null;
  force: boolean;
}

interface TranslationsData {
  input: string;
  entity: {
    name: string;
    entityType: "PAGE" | "COMPONENT";
    draftId: string | null;
    publishedId: string;
  };
  status: DepStatus;
  check: TranslationCheckResult;
}

function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i === -1 ? undefined : rest[i + 1];
}

function parseStatus(raw: string | undefined): DepStatus {
  if (!raw) return "PUBLISHED";
  const upper = raw.toUpperCase();
  if (upper === "PUBLISHED" || upper === "DRAFT") return upper;
  throw new CliError(`Invalid --status "${raw}". Use PUBLISHED or DRAFT.`, {
    code: "PD_BAD_STATUS",
  });
}

const command: CommandModule<TranslationsArgs, TranslationsData> = {
  schema: "pd.translations",

  parseArgs(args) {
    const { common, rest } = parsePdCommonArgs(args);
    const input = rest[0];
    if (!input || input.startsWith("-")) {
      throw new CliError("Missing <input>. Provide a PD page/component id, name, or URL.", {
        code: "MISSING_INPUT",
      });
    }
    return {
      input,
      status: parseStatus(flagValue(rest, "--status")),
      expectDraft: flagValue(rest, "--expect-draft") ?? null,
      force: common.force,
    };
  },

  async execute({ input, status, expectDraft, force }) {
    const entity = await resolveEntityIds(input, force);
    if (!entity.publishedId) {
      throw new CliError(
        `"${entity.name}" has no published version — page-dependencies needs a published id.`,
        { code: "PD_NOT_PUBLISHED", details: { input, name: entity.name } },
      );
    }
    const deps = await pdApi.fetchPageDependencies(entity.publishedId, status);
    const expectedDraftId = expectDraft ?? entity.draftId;
    const check = validateTranslationPhrases(deps, entity.publishedId, expectedDraftId);

    return ok<TranslationsData>({
      input,
      entity: {
        name: entity.name,
        entityType: entity.entityType,
        draftId: entity.draftId,
        publishedId: entity.publishedId,
      },
      status,
      check,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as TranslationsData;
    const { check } = data;

    ui.kv("Entity", `${data.entity.name}  (${data.entity.entityType})`);
    ui.kv("Published ID", data.entity.publishedId);
    ui.kv("Draft ID", data.entity.draftId ?? "N/A");
    ui.kv("Phrases", `${check.totalPhrases} across ${check.phraseArrayCount} entit${check.phraseArrayCount === 1 ? "y" : "ies"}`);

    if (check.verdict === "PASS") {
      ui.success(`PASS — ${check.reason}`);
    } else if (check.verdict === "N/A") {
      ui.warn(`N/A — ${check.reason}`);
    } else {
      ui.error(`FAIL — ${check.reason}`);
      if (check.badKeys.length > 0) {
        ui.section("Malformed keys (sample)");
        for (const b of check.badKeys) ui.text(`  ${b.array}: ${b.key}`);
      }
    }
  },
};

export default command;
