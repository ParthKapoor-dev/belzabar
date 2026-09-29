// belz pd page-deps — raw page-dependencies API wrapper.
//
//   belz pd page-deps <input> [--status PUBLISHED|DRAFT]
//
// Resolves <input> (id / name / URL) to its published id and queries
// /rest/api/pagedesigner/pages/page-dependencies. The raw `dependencyJSON`
// carries every entity's full page row (configuration included) plus its
// translated/original phrase arrays — 6 MB for "Student Application" — so the
// default output is a summary: one row per entity (name, ids, status,
// config bytes, phrase counts). `--full` returns the raw `dependencyJSON`.
// No validation — see `belz pd translations` for the release-check verdict.

import { asObj, CliError, defineArgs, ok, type CommandModule } from "@belzabar/core";
import { PD_DEP_STATUS_FLAG, PD_FORCE_FLAG, PD_INPUT_POSITIONAL } from "../../lib/args/common";
import { pdApi } from "../../lib/api/index";
import { resolveEntityIds } from "../../lib/page-dependencies";

type DepStatus = "PUBLISHED" | "DRAFT";

interface PageDepsArgs {
  input: string;
  status: DepStatus;
  force: boolean;
  full: boolean;
}

/** One entity of the dependency graph (the queried one first). */
interface DepEntity {
  /** The dependencyJSON key: the published id for the queried entity, the component name for dependencies. */
  key: string;
  name: string | null;
  id: string | null;
  status: string | null;
  isComponent: boolean;
  referenceId: string | null;
  configBytes: number;
  translatedPhrases: number;
  originalPhrases: number;
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
  counts: { entities: number; translatedPhrases: number; originalPhrases: number };
  entities: DepEntity[];
  /** --full only. */
  dependencyKeys?: string[];
  /** --full only: the raw graph. */
  dependencyJSON?: Record<string, unknown>;
}

const TRANSLATED = "__translated_phrases";
const ORIGINAL = "__original_phrases";

/** Summarise a raw dependencyJSON: one row per entity, phrase arrays counted. */
export function summarizeDependencies(dependencyJSON: Record<string, unknown>, rootKey: string): DepEntity[] {
  const bases = new Set<string>();
  for (const k of Object.keys(dependencyJSON)) bases.add(k.replace(new RegExp(`(${TRANSLATED}|${ORIGINAL})$`), ""));
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const rows = [...bases].map((key): DepEntity => {
    const row = dependencyJSON[key];
    const r = asObj(row) ?? {};
    return {
      key,
      name: str(r.name),
      id: str(r.id),
      status: str(r.status),
      isComponent: r.isComponent === true,
      referenceId: str(r.referenceId),
      configBytes: typeof r.configuration === "string" ? Buffer.byteLength(r.configuration, "utf8") : 0,
      translatedPhrases: len(dependencyJSON[`${key}${TRANSLATED}`]),
      originalPhrases: len(dependencyJSON[`${key}${ORIGINAL}`]),
    };
  });
  return rows.sort((a, b) => Number(b.key === rootKey) - Number(a.key === rootKey) || a.key.localeCompare(b.key));
}

export const args = defineArgs({
  command: "belz pd page-deps",
  positionals: [PD_INPUT_POSITIONAL],
  flags: { ...PD_DEP_STATUS_FLAG, ...PD_FORCE_FLAG, full: { type: "boolean" } },
});

const command: CommandModule<PageDepsArgs, PageDepsData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { input: positionals.input, status: flags.status, force: flags.force, full: flags.full };
  },

  async execute({ input, status, force, full }) {
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
    const entities = summarizeDependencies(dependencyJSON, entity.publishedId);
    return ok<PageDepsData>({
      input,
      entity: {
        name: entity.name,
        entityType: entity.entityType,
        draftId: entity.draftId,
        publishedId: entity.publishedId,
      },
      status,
      counts: {
        entities: entities.length,
        translatedPhrases: entities.reduce((n, e) => n + e.translatedPhrases, 0),
        originalPhrases: entities.reduce((n, e) => n + e.originalPhrases, 0),
      },
      entities,
      ...(full ? { dependencyKeys: Object.keys(dependencyJSON), dependencyJSON } : {}),
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as PageDepsData;
    ui.kv("Entity", `${data.entity.name}  (${data.entity.entityType})`);
    ui.kv("Published ID", data.entity.publishedId);
    ui.kv("Status", data.status);
    ui.kv("Entities", String(data.counts.entities));
    ui.kv("Phrases", `${data.counts.translatedPhrases} translated, ${data.counts.originalPhrases} original`);
    ui.table(
      ["Key", "Name", "Id", "Status", "Config B", "Translated", "Original"],
      data.entities.map((e) => [e.key, e.name ?? "", e.id ?? "", e.status ?? "", e.configBytes, e.translatedPhrases, e.originalPhrases]),
    );
    if (data.dependencyJSON) {
      ui.section("dependencyJSON");
      ui.object(data.dependencyJSON);
    }
  },
};

export default command;
