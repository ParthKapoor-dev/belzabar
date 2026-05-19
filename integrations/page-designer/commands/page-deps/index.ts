// belz pd page-deps — raw page-dependencies API wrapper.
//
//   belz pd page-deps <input> [--status PUBLISHED|DRAFT]
//
// Resolves <input> (id / name / URL) to its published id and returns the raw
// `dependencyJSON` from /rest/api/pagedesigner/pages/page-dependencies. No
// validation — see `belz pd translations` for the release-check verdict.

import { CliError, ok, type CommandModule } from "@belzabar/core";
import { parsePdCommonArgs } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { resolveEntityIds } from "../../lib/page-dependencies";

type DepStatus = "PUBLISHED" | "DRAFT";

interface PageDepsArgs {
  input: string;
  status: DepStatus;
  force: boolean;
}

interface PageDepsData {
  input: string;
  entity: {
    name: string;
    entityType: "PAGE" | "COMPONENT";
    draftId: string | null;
    publishedId: string;
  };
  status: DepStatus;
  dependencyKeys: string[];
  dependencyJSON: Record<string, unknown>;
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

const command: CommandModule<PageDepsArgs, PageDepsData> = {
  schema: "pd.page-deps",

  parseArgs(args) {
    const { common, rest } = parsePdCommonArgs(args);
    const input = rest[0];
    if (!input || input.startsWith("-")) {
      throw new CliError("Missing <input>. Provide a PD page/component id, name, or URL.", {
        code: "MISSING_INPUT",
      });
    }
    return { input, status: parseStatus(flagValue(rest, "--status")), force: common.force };
  },

  async execute({ input, status, force }) {
    const entity = await resolveEntityIds(input, force);
    if (!entity.publishedId) {
      throw new CliError(
        `"${entity.name}" has no published version — page-dependencies needs a published id.`,
        { code: "PD_NOT_PUBLISHED", details: { input, name: entity.name } },
      );
    }
    const deps = await pdApi.fetchPageDependencies(entity.publishedId, status);
    const dependencyJSON =
      deps.dependencyJSON && typeof deps.dependencyJSON === "object" ? deps.dependencyJSON : {};
    return ok<PageDepsData>({
      input,
      entity: {
        name: entity.name,
        entityType: entity.entityType,
        draftId: entity.draftId,
        publishedId: entity.publishedId,
      },
      status,
      dependencyKeys: Object.keys(dependencyJSON),
      dependencyJSON,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as PageDepsData;
    ui.kv("Entity", `${data.entity.name}  (${data.entity.entityType})`);
    ui.kv("Published ID", data.entity.publishedId);
    ui.kv("Status", data.status);
    ui.kv("dependencyJSON keys", String(data.dependencyKeys.length));
    ui.section("dependencyJSON");
    ui.object(data.dependencyJSON);
  },
};

export default command;
