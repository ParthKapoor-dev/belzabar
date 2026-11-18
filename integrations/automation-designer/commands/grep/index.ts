// wi-impl ad grep <regex> (--category a,b | --all | --method <uuid>...) [--in sql,code,spel,call]
//   [--include descriptions,tests]
//
// Search the text of method steps: SQL, custom code, SpEL conditions, echo expressions, input
// values and called-method names (and on request descriptions and test cases). Read-only. Body
// reading and caching are shared with `ad callers` (lib/callers.ts); extraction and matching
// live in lib/grep.ts.

import { CliError, defineArgs, levenshtein, lifecycle, normalizeSearchText, ok, type CommandModule } from "@belzabar/core";
import { resolveMethodRef } from "@belzabar/core/platform";
import { loadDirtyMethods, loadOrBuildMethodFinderIndex, METHOD_FINDER_SCHEMA } from "../../lib/method-finder";
import { compilePattern, GREP_INCLUDES, GREP_KINDS, grepMethods, type GrepCoverage, type GrepInclude, type GrepKind, type GrepMatch } from "../../lib/grep";
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
    /** `--category` names the index does not know (not searched), with close names. */
    unknownCategories?: Array<{ name: string; suggestions: string[] }>;
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
    include: { type: "string" },
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

/** Up to three indexed category names close to `name`: a small edit distance, or containing it. */
function closeCategories(name: string, known: string[]): string[] {
  const q = normalizeSearchText(name);
  return known
    .map((k) => {
      const n = normalizeSearchText(k);
      const d = levenshtein(q, n);
      return { k, d: d <= Math.max(2, Math.floor(n.length / 3)) ? d : n.includes(q) || q.includes(n) ? 100 : Infinity };
    })
    .filter((x) => x.d !== Infinity)
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    .slice(0, 3)
    .map((x) => x.k);
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
    const includes = list(flags.include);
    const badInclude = includes.filter((k) => !(k in GREP_INCLUDES));
    if (badInclude.length || (flags.include !== undefined && includes.length === 0)) {
      throw new CliError(`--include takes a comma list of ${Object.keys(GREP_INCLUDES).join(", ")}; got '${flags.include}'.`, { code: "INVALID_VALUE" });
    }
    for (const i of includes) kinds.push(GREP_INCLUDES[i as GrepInclude]);
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

    // An unknown name is warned about and the rest are searched; only all-unknown fails.
    const knownNames = index.categories.map((c) => c.name);
    const known = new Set(knownNames.map((c) => c.toLowerCase()));
    const unknown = a.categories.filter((c) => !known.has(c.toLowerCase())).map((name) => ({ name, suggestions: closeCategories(name, knownNames) }));
    const hint = unknown.map((u) => `${u.name}${u.suggestions.length ? ` (did you mean: ${u.suggestions.join(", ")}?)` : ""}`).join("; ");
    if (a.categories.length && unknown.length === a.categories.length) {
      throw new CliError(`Unknown category: ${hint}.`, { code: "CATEGORY_NOT_FOUND", details: { unknown: unknown.map((u) => u.name), suggestions: Object.fromEntries(unknown.map((u) => [u.name, u.suggestions])) } });
    }
    if (unknown.length) context.warn(`Unknown categories not searched: ${hint}.`);
    const wanted = new Set(a.categories.filter((c) => known.has(c.toLowerCase())).map((c) => c.toLowerCase()));

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
        ...(unknown.length ? { unknownCategories: unknown } : {}),
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
        d.matches.map((m) => [`${m.category}/${m.method}\n${m.uuid}`, m.state, m.step === 0 ? "-" : m.stepDescription ? `${m.step} ${m.stepDescription}` : m.step, m.field, m.line, m.excerpt]),
      );
    }
    const c = d.coverage;
    ui.text(`${d.total} match(es); searched ${c.scanned} method(s)${c.unscanned ? `, ${c.unscanned} unreadable` : ""}.`);
    for (const e of c.errors ?? []) ui.warn(e);
    if (c.skippedCategories?.length) ui.warn(`Not indexed (listing failed): ${c.skippedCategories.join(", ")}.`);
  },
};

export default command;
