// belz ad callers <uuid|url> [--category a,b | --all] [--pd] [--refresh]
//
// Reverse index (Stage 7.6): which AD methods — and with --pd which PD pages /
// components — call the given method. Read-only. Scope and caching are
// documented in lib/callers.ts.

import { CliError, defineArgs, lifecycle, ok, type CommandModule } from "@belzabar/core";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { resolveMethodRef } from "@belzabar/core/platform";
import { loadDirtyMethods, loadOrBuildMethodFinderIndex, METHOD_FINDER_SCHEMA } from "../../lib/method-finder";
import {
  findAdCallers,
  findPdCallers,
  resolveCallTarget,
  type AdCaller,
  type AdCallersResult,
  type CallTarget,
  type PdCaller,
} from "../../lib/callers";
import { loadPdRefs } from "@belzabar/pd/lib/ad-refs";

interface CallersArgs {
  uuid: string;
  categories: string[];
  all: boolean;
  pd: boolean;
  refresh: boolean;
}

interface CallersData {
  target: Pick<CallTarget, "name" | "category" | "state" | "uuid" | "referenceId"> & { apiUuids: string[]; apiIds?: number[] };
  total: number;
  callers: AdCaller[];
  pd?: { total: number; callers: PdCaller[]; source: "cache" | "fresh" };
  coverage: AdCallersResult["coverage"] & {
    indexAgeMinutes: number;
    indexSource: "cache" | "fresh";
    /** Categories whose method listing failed while the index was built: their methods were not scanned. */
    skippedCategories?: string[];
    /**
     * True only for a fresh, complete index with every candidate resolved. A
     * cached index misses methods created or edited outside belz since it was
     * built (belz's own writes are re-read).
     */
    complete: boolean;
  };
}

/** `callers` rebuilds an index older than this (find keeps the 7-day TTL). */
export const CALLERS_INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const args = defineArgs({
  command: "belz ad callers",
  positionals: [
    { name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid> argument." },
  ],
  flags: {
    ...AD_COMMON_FLAGS,
    category: { type: "string" },
    all: { type: "boolean" },
    pd: { type: "boolean" },
    refresh: { type: "boolean" },
  },
  exclusive: [["category", "all"]],
});

const command: CommandModule<CallersArgs, CallersData> = {
  schema: "ad.callers",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "list", "callers");
    const categories = (flags.category ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    if (flags.category !== undefined && categories.length === 0) {
      throw new CliError("--category needs at least one category name.", { code: "MISSING_VALUE" });
    }
    return { uuid: resolveMethodRef(positionals.uuid), categories, all: flags.all, pd: flags.pd, refresh: flags.refresh };
  },
  async execute({ uuid, categories, all, pd, refresh }, context) {
    const target = await resolveCallTarget(uuid);
    const { index, source } = await loadOrBuildMethodFinderIndex({
      refresh,
      minSchema: METHOD_FINDER_SCHEMA,
      maxAgeMs: CALLERS_INDEX_MAX_AGE_MS,
      onProgress: ({ done, total, category }) => {
        if (done === 1 || done === total || done % 10 === 0) lifecycle.notice(`Indexing AD methods: ${done}/${total} categories (${category})`);
      },
    });
    const ageMinutes = Math.round((Date.now() - index.generatedAt) / 60000);
    if (source === "cache") {
      context.warn(
        `Using the cached method index (${ageMinutes} min old): methods created or edited outside belz since then are missed ` +
          "(belz's own writes are re-read). Use --refresh to rebuild it.",
      );
    }
    const skipped = (index.skippedCategories ?? []).map((c) => c.categoryName);
    if (skipped.length) {
      context.warn(
        `${skipped.length} categories could not be listed when the index was built (${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}); ` +
          "their callers are missed. Use --refresh to retry.",
      );
    }
    const dirty = await loadDirtyMethods(index);

    if (categories.length) {
      const known = new Set(index.categories.map((c) => c.name.toLowerCase()));
      const unknown = categories.filter((c) => !known.has(c.toLowerCase()));
      if (unknown.length) {
        throw new CliError(`Unknown category: ${unknown.join(", ")}.`, { code: "CATEGORY_NOT_FOUND", details: { unknown } });
      }
    }
    const deep = all ? null : new Set([target.category, ...categories].filter(Boolean).map((c) => c.toLowerCase()));
    const ad = await findAdCallers(index, target, { deep, dirty }, { retryFailed: refresh });
    if (ad.coverage.unscannedMethods > 0) {
      context.warn(
        `${ad.coverage.unscannedMethods} methods in ${ad.coverage.unscannedCategories?.length ?? 0} other categories have steps the index cannot resolve; ` +
          "they may hide callers — add --category <name> or --all.",
      );
    }

    const data: CallersData = {
      target: {
        name: target.name,
        category: target.category,
        state: target.state,
        uuid: target.uuid,
        ...(target.referenceId ? { referenceId: target.referenceId } : {}),
        apiUuids: target.apiUuids,
        ...(target.apiIds.length ? { apiIds: target.apiIds } : {}),
      },
      total: ad.callers.length,
      callers: ad.callers,
      coverage: {
        ...ad.coverage,
        indexAgeMinutes: ageMinutes,
        indexSource: source,
        ...(skipped.length ? { skippedCategories: skipped } : {}),
        complete: source === "fresh" && skipped.length === 0 && ad.coverage.unscannedMethods === 0 && !ad.coverage.errors?.length,
      },
    };

    if (pd) {
      const refs = await loadPdRefs(refresh);
      const found = findPdCallers(refs.items, target);
      data.pd = { total: found.length, callers: found, source: refs.source };
    }
    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as CallersData;
    ui.section(`Callers of ${d.target.category}/${d.target.name} [${d.target.state}] ${d.target.uuid}`);
    if (d.callers.length === 0) ui.text(`No AD method calls it (in the scanned scope${d.coverage.complete ? "" : "; coverage is incomplete, see below"}).`);
    else ui.table(["Category", "Method", "State", "UUID", "Steps"], d.callers.map((c) => [c.category, c.name, c.state, c.uuid, c.steps.join("\n")]));
    const cov = d.coverage;
    ui.text(
      `Scanned ${cov.indexedMethods} indexed methods (index ${cov.indexAgeMinutes} min old); read ${cov.resolvedMethods} bodies; deep scope: ${
        cov.deepCategories === "all" ? "all categories" : cov.deepCategories.join(", ") || "(none)"
      }.`,
    );
    if (cov.unscannedMethods) ui.warn(`${cov.unscannedMethods} methods outside the deep scope were not fully resolved (--all to include).`);
    if (cov.skippedCategories?.length) ui.warn(`Not indexed (listing failed): ${cov.skippedCategories.join(", ")}.`);
    for (const e of cov.errors ?? []) ui.warn(e);
    if (d.pd) {
      ui.section(`PD pages / components (${d.pd.total}, ${d.pd.source})`);
      if (d.pd.callers.length === 0) ui.text("None.");
      else ui.table(["Type", "Name", "Status", "ID", "HTTP calls"], d.pd.callers.map((p) => [p.type, p.name, p.status, p.id, p.calls.join("\n")]));
    }
  },
};

export default command;
