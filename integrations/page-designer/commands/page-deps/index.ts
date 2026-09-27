// belz pd page-deps — raw page-dependencies API wrapper.
//
//   belz pd page-deps <input> [--status PUBLISHED|DRAFT]
//
// Resolves <input> (id / name / URL) to its published id and returns the raw
// `dependencyJSON` from /rest/api/pagedesigner/pages/page-dependencies. No
// validation — see `belz pd translations` for the release-check verdict.

import { CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { PD_DEP_STATUS_FLAG, PD_FORCE_FLAG, PD_INPUT_POSITIONAL } from "../../lib/args/common";
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

export const args = defineArgs({
  command: "belz pd page-deps",
  positionals: [PD_INPUT_POSITIONAL],
  flags: { ...PD_DEP_STATUS_FLAG, ...PD_FORCE_FLAG },
});

const command: CommandModule<PageDepsArgs, PageDepsData> = {
  schema: "pd.page-deps",

  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { input: positionals.input, status: flags.status, force: flags.force };
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
