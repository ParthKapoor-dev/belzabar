// wi-impl ad grep <regex> (--category a,b | --all | --method <uuid>...) [--in sql,code,spel]
//
// Search the text of method steps: SQL, custom code, SpEL conditions, echo expressions and
// input values. Read-only. Body reading and caching are shared with `ad callers`
// (lib/callers.ts); extraction and matching live in lib/grep.ts.

import { CliError, defineArgs, lifecycle, ok, type CommandModule } from "@belzabar/core";
import { resolveMethodRef } from "@belzabar/core/platform";
import { loadDirtyMethods, loadOrBuildMethodFinderIndex, METHOD_FINDER_SCHEMA } from "../../lib/method-finder";
import { compilePattern, GREP_KINDS, grepMethods, type GrepCoverage, type GrepKind, type GrepMatch } from "../../lib/grep";
import { CALLERS_INDEX_MAX_AGE_MS } from "../callers/index";

interface GrepArgs {
  pattern: string;
  categories: string[];
  all: boolean;
  methods: string[];
  kinds: GrepKind[];
  ignoreCase: boolean;
  state?: "DRAFT" | "PUBLISHED";
  refresh: boolean;
}

interface GrepData {
  pattern: string;
  in: GrepKind[];
  total: number;
  matches: GrepMatch[];
  coverage: GrepCoverage & {
    scope: string[] | "all" | "methods";
    indexAgeMinutes?: number;
    indexSource?: "cache" | "fresh";
    /** Categories whose listing failed when the index was built: not searched. */
    skippedCategories?: string[];
  };
}

export const args = defineArgs({
  command: "wi-impl ad grep",
  positionals: [{ name: "pattern", required: true, missingCode: "MISSING_PATTERN", missingMessage: "Missing <pattern> argument." }],
  flags: {
    category: { type: "string" },
    all: { type: "boolean" },
    method: { type: "string", repeatable: true },
    in: { type: "string" },
    "ignore-case": { type: "boolean", alias: ["-i"] },
    draft: { type: "boolean" },
    published: { type: "boolean" },
    refresh: { type: "boolean" },
  },
  exclusive: [["category", "all", "method"], ["draft", "published"]],
  requireOneOf: [["category", "all", "method"]],
});

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((c) => c.trim()).filter(Boolean);
}

const command: CommandModule<GrepArgs, GrepData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    const categories = list(flags.category);
    if (flags.category !== undefined && categories.length === 0) {
      throw new CliError("--category needs at least one category name.", { code: "MISSING_VALUE" });
    }
    const kinds = flags.in === undefined || flags.in === "all" ? [...GREP_KINDS] : list(flags.in);
    const bad = kinds.filter((k) => !(GREP_KINDS as readonly string[]).includes(k));
    if (bad.length || kinds.length === 0) {
      throw new CliError(`--in takes a comma list of ${GREP_KINDS.join(", ")} (or all); got '${flags.in}'.`, { code: "INVALID_VALUE" });
    }
    compilePattern(positionals.pattern, flags.ignoreCase); // fail before any read
    return {
      pattern: positionals.pattern,
      categories,
      all: flags.all,
      methods: flags.method.map(resolveMethodRef),
      kinds: kinds as GrepKind[],
      ignoreCase: flags.ignoreCase,
      state: flags.draft ? "DRAFT" : flags.published ? "PUBLISHED" : undefined,
      refresh: flags.refresh,
    };
  },
  async execute(a, context) {
    const re = compilePattern(a.pattern, a.ignoreCase);
    const kinds = new Set(a.kinds);
    if (a.methods.length) {
      const r = await grepMethods({ methods: [], uuids: a.methods, re, kinds });
      const matches = a.state ? r.matches.filter((m) => m.state === a.state) : r.matches;
      return ok({ pattern: a.pattern, in: a.kinds, total: matches.length, matches, coverage: { ...r.coverage, scope: "methods" } });
    }

    const { index, source } = await loadOrBuildMethodFinderIndex({
      refresh: a.refresh,
      minSchema: METHOD_FINDER_SCHEMA,
      maxAgeMs: CALLERS_INDEX_MAX_AGE_MS,
      onProgress: ({ done, total, category }) => {
        if (done === 1 || done === total || done % 10 === 0) lifecycle.notice(`Indexing AD methods: ${done}/${total} categories (${category})`);
      },
    });
    const ageMinutes = Math.round((Date.now() - index.generatedAt) / 60000);
    if (source === "cache") {
      context.warn(`Using the cached method index (${ageMinutes} min old): methods created in the AD UI since then are missed. Use --refresh to rebuild it.`);
    }
    const skipped = (index.skippedCategories ?? []).map((c) => c.categoryName);
    if (skipped.length) context.warn(`${skipped.length} categories could not be listed when the index was built; they are not searched. Use --refresh to retry.`);

    const wanted = new Set(a.categories.map((c) => c.toLowerCase()));
    if (wanted.size) {
      const known = new Set(index.categories.map((c) => c.name.toLowerCase()));
      const unknown = a.categories.filter((c) => !known.has(c.toLowerCase()));
      if (unknown.length) throw new CliError(`Unknown category: ${unknown.join(", ")}.`, { code: "CATEGORY_NOT_FOUND", details: { unknown } });
    }
    const methods = index.methods.filter((m) => (a.all || wanted.has(m.categoryName.toLowerCase())) && (!a.state || m.state === a.state));
    const r = await grepMethods({ methods, dirty: await loadDirtyMethods(index), re, kinds, retryFailed: a.refresh });
    return ok({
      pattern: a.pattern,
      in: a.kinds,
      total: r.matches.length,
      matches: r.matches,
      coverage: {
        ...r.coverage,
        scope: a.all ? "all" : a.categories,
        indexAgeMinutes: ageMinutes,
        indexSource: source,
        ...(skipped.length ? { skippedCategories: skipped } : {}),
      },
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const d = envelope.data as GrepData;
    if (d.matches.length === 0) ui.text(`No match for /${d.pattern}/ in ${d.in.join(", ")}.`);
    else {
      ui.table(
        ["Method", "State", "Step", "Where", "Line", "Text"],
        d.matches.map((m) => [`${m.category}/${m.method}\n${m.uuid}`, m.state, m.stepDescription ? `${m.step} ${m.stepDescription}` : m.step, m.field, m.line, m.excerpt]),
      );
    }
    const c = d.coverage;
    ui.text(`${d.total} match(es); searched ${c.scanned} method(s)${c.unscanned ? `, ${c.unscanned} unreadable` : ""}.`);
    for (const e of c.errors ?? []) ui.warn(e);
    if (c.skippedCategories?.length) ui.warn(`Not indexed (listing failed): ${c.skippedCategories.join(", ")}.`);
  },
};

export default command;
