#!/usr/bin/env bun
// `bun run docs:check` — keeps AGENTS.md / README.md files honest.
//
// Two checks over every AGENTS.md and README.md in the repo (.claude/,
// node_modules/, fixtures and the untracked expertly.coding.agents/ are skipped):
//
//   1. Paths. Every code span, markdown link target and fenced-block token that
//      looks like a repo path (at least two segments, e.g. `lib/save/verify.ts`)
//      must exist. A path is resolved against the doc's own directory first, then
//      the repo root, but only when its first segment exists there — so API routes
//      (`chain/v2`) and runtime paths (`~/.wi-impl/…`) are not mistaken for repo paths.
//      Placeholders (`<uuid>`, `*`, `{a,b}`, `…`) make a token unverifiable: skipped.
//      A path without an extension also matches `<path>.ts` or `<path>/index.ts`.
//      `@belzabar/<pkg>` imports must name a real workspace package.
//   2. Commands. Every `belz <ns> <cmd> [<sub>]` inside code (spans or fenced
//      blocks) must be a registered command; a subcommand word is checked when the
//      command declares `defineSubcommands` without a default.
//
// A line containing `docs-check:ignore` is skipped (checks 1 and 2 only).
//
// Three structural checks over the tracked (and untracked, not ignored) files:
//
//   3. README coverage. Every workspace root (packages/*, apps/*, integrations/*
//      with a package.json), `scripts/`, and every directory below them that
//      holds files needs a README.md — except command folders (anything below
//      `commands/<name>/`, whose help.txt is the doc), fixture directories
//      (`fixtures/` below a `tests/` dir, documented by manifest.json),
//      node_modules and build output.
//   4. No README.md inside a command folder.
//   5. AGENTS.md stays thin: at most AGENTS_MAX_LINES lines, and no run of
//      DUPLICATE_RUN consecutive content lines copied from a README.md.

import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";

interface CommandIndex {
  /** Top-level commands (`belz <cmd>`) → their subcommand info. */
  top: Map<string, SubInfo>;
  /** Namespaces (`belz <ns> <cmd>`) → command → subcommand info. */
  namespaces: Map<string, Map<string, SubInfo>>;
}

/** A command's subcommand names (null when it has none, or has a default subcommand). */
type SubInfo = { strict: Set<string> } | null;

interface Problem {
  file: string;
  line: number;
  message: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".claude", "expertly.coding.agents",
  "fixtures", "dist", "build", "dist-pack", ".turbo", ".next",
]);
const DOC_NAMES = new Set(["AGENTS.md", "README.md"]);

/** Every AGENTS.md / README.md under `root` (repo-relative, sorted). */
export function findDocs(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name));
      } else if (DOC_NAMES.has(e.name)) {
        out.push(relative(root, join(dir, e.name)));
      }
    }
  };
  visit(root);
  return out.sort();
}

interface Snippet {
  text: string;
  line: number;
  /** "code" = inline code span or fenced block; "link" = markdown link target. */
  kind: "code" | "link";
}

/** Code spans, fenced-block lines and link targets of a markdown document. */
export function extractSnippets(markdown: string): Snippet[] {
  const out: Snippet[] = [];
  let fence: string | null = null;
  markdown.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (raw.includes("docs-check:ignore")) return;
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1]!.startsWith(fence)) fence = null;
      return;
    }
    if (fence !== null) {
      out.push({ text: raw, line, kind: "code" });
      return;
    }
    for (const m of raw.matchAll(/(`+)([^`]+?)\1(?!`)/g)) out.push({ text: m[2]!, line, kind: "code" });
    const prose = raw.replace(/(`+)[^`]+?\1(?!`)/g, "");
    for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ text: m[1]!, line, kind: "link" });
  });
  return out;
}

const PLACEHOLDER = /[<>{}*$…|?\[\]]|\.\.\./;
const EXT_FALLBACKS = ["", ".ts", ".tsx", ".js", ".mjs", ".md", "/index.ts", "/index.js"];

/** Path-looking tokens of one snippet (trailing punctuation, `:line` and `#anchor` stripped). */
export function pathCandidates(snippet: Snippet): string[] {
  const tokens = snippet.kind === "link" ? [snippet.text] : snippet.text.split(/[\s=,;()"'`]+/);
  const out: string[] = [];
  for (let t of tokens) {
    if (!t || /^[a-z]+:\/\//i.test(t) || t.startsWith("mailto:")) continue;
    t = t.replace(/#.*$/, "").replace(/[.,:;!]+$/, "").replace(/:\d+(-\d+)?$/, "");
    if (t.startsWith("./")) t = t.slice(2);
    if (!t || t.startsWith("/") || t.startsWith("~") || t.startsWith("-") || PLACEHOLDER.test(t)) continue;
    const trimmed = t.replace(/\/+$/, "");
    // Needs an internal slash: single names in trees/prose are not checkable.
    if (!/^[\w.@-]+(\/[\w.@-]+)+$/.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

function existsWithFallback(p: string): boolean {
  return EXT_FALLBACKS.some((ext) => existsSync(p + ext));
}

/**
 * Checks one path token. Returns an error message, or null when it exists or
 * is not anchored in the repo (its first segment exists neither next to the
 * doc nor at the root).
 */
function checkPath(root: string, docDir: string, token: string, packages: Map<string, string>): string | null {
  if (token.startsWith("@")) {
    const [scope, name] = token.split("/");
    const pkg = `${scope}/${name}`;
    if (scope !== "@belzabar") return null;
    return packages.has(pkg) ? null : `unknown package ${pkg}`;
  }
  if (token.startsWith("../")) {
    return existsWithFallback(resolve(docDir, token)) ? null : `missing path ${token}`;
  }
  const first = token.split("/")[0]!;
  const bases = [docDir, root].filter((b) => existsSync(join(b, first)));
  if (bases.length === 0) return null;
  return bases.some((b) => existsWithFallback(join(b, token))) ? null : `missing path ${token}`;
}

/** `belz …` invocations inside a code snippet, as word lists (stopping at a flag/placeholder). */
export function commandCandidates(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(/(?<![\w.:\[-])belz((?:[ \t]+[a-z][\w-]*)+)/g)) {
    out.push(m[1]!.trim().split(/[ \t]+/));
  }
  return out;
}

/** Null when `words` (after `belz`) name a registered command, else the problem. */
export function checkCommand(index: CommandIndex, words: string[]): string | null {
  const [first, second, third] = words;
  if (!first) return null;
  const inv = `belz ${words.slice(0, 3).join(" ")}`;
  const checkSub = (info: SubInfo, sub: string | undefined, label: string) =>
    info && sub && !info.strict.has(sub) ? `unknown subcommand in \`${inv}\` (${label} has: ${[...info.strict].sort().join(", ")})` : null;

  const ns = index.namespaces.get(first);
  if (ns) {
    if (!second) return null;
    if (!ns.has(second)) return `unknown command \`belz ${first} ${second}\``;
    return checkSub(ns.get(second)!, third, `${first} ${second}`);
  }
  if (index.top.has(first)) return checkSub(index.top.get(first)!, second, first);
  return `unknown command \`belz ${first}\``;
}

/** Check the given docs. Paths are repo-relative. */
export function checkDocs(root: string, docs: string[], index: CommandIndex, packages: Map<string, string>): Problem[] {
  const problems: Problem[] = [];
  for (const doc of docs) {
    const abs = join(root, doc);
    const docDir = dirname(abs);
    for (const snippet of extractSnippets(readFileSync(abs, "utf8"))) {
      for (const token of pathCandidates(snippet)) {
        const msg = checkPath(root, docDir, token, packages);
        if (msg) problems.push({ file: doc, line: snippet.line, message: msg });
      }
      if (snippet.kind !== "code") continue;
      for (const words of commandCandidates(snippet.text)) {
        const msg = checkCommand(index, words);
        if (msg) problems.push({ file: doc, line: snippet.line, message: msg });
      }
    }
  }
  return problems;
}

type RegistryLike = Record<string, { module: unknown }>;

function subInfo(module: unknown): SubInfo {
  const mod = module as { args?: { kind?: string; subcommands?: Record<string, unknown>; options?: { default?: string; aliases?: Record<string, string> } } };
  const def = mod.args;
  if (!def || def.kind !== "subcommands" || def.options?.default) return null;
  return { strict: new Set([...Object.keys(def.subcommands ?? {}), ...Object.keys(def.options?.aliases ?? {})]) };
}

/** Builds the command index from namespace → registry maps. */
export function buildIndex(namespaces: Record<string, RegistryLike>, top: RegistryLike): CommandIndex {
  const index: CommandIndex = { top: new Map(), namespaces: new Map() };
  for (const [ns, reg] of Object.entries(namespaces)) {
    index.namespaces.set(ns, new Map(Object.entries(reg).map(([k, v]) => [k, subInfo(v.module)])));
  }
  for (const [k, v] of Object.entries(top)) index.top.set(k, subInfo(v.module));
  return index;
}

/** `@belzabar/*` package name → workspace dir. */
export function workspacePackages(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of ["packages", "apps", "integrations"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pj = join(dir, name, "package.json");
      if (!existsSync(pj) || !statSync(pj).isFile()) continue;
      const pkg = JSON.parse(readFileSync(pj, "utf8")) as { name?: string };
      if (pkg.name) out.set(pkg.name, join(group, name));
    }
  }
  return out;
}

// ── Structural checks: README coverage, command folders, thin AGENTS.md ──────

/** Max lines of an AGENTS.md (they hold agent rules and links, not docs). */
export const AGENTS_MAX_LINES = 120;
/** Consecutive content lines shared with a README that count as duplication. */
const DUPLICATE_RUN = 3;

const WORKSPACE_GROUPS = ["packages", "apps", "integrations"];
/** Directories never documented or required to be (build output, deps, VCS). */
const STRUCTURE_SKIP = new Set(["node_modules", "dist", "build", "dist-pack", "coverage", ".turbo", ".next", ".git"]);

/** True for a directory inside a command folder (`…/commands/<name>/…`). */
export function isInCommandFolder(dir: string): boolean {
  const segs = dir.split("/");
  const i = segs.lastIndexOf("commands");
  return i >= 0 && i < segs.length - 1;
}

/** True for a fixture directory: `fixtures/` (or below) inside a `tests/` dir. */
export function isFixtureDir(dir: string): boolean {
  const segs = dir.split("/");
  const t = segs.indexOf("tests");
  return t >= 0 && segs.indexOf("fixtures", t + 1) > t;
}

/**
 * Directories that must hold a README.md, from repo-relative file paths.
 * `workspaceRoots` are the dirs of the workspace package.json files.
 */
export function requiredReadmeDirs(files: readonly string[], workspaceRoots: readonly string[]): string[] {
  const scopes = [...workspaceRoots, "scripts"];
  const out = new Set<string>(workspaceRoots);
  for (const file of files) {
    const scope = scopes.find((s) => file.startsWith(s + "/"));
    if (!scope) continue;
    let dir = dirname(file);
    while (dir.length >= scope.length) {
      const segs = dir.split("/");
      if (!segs.some((seg) => STRUCTURE_SKIP.has(seg)) && !isInCommandFolder(dir) && !isFixtureDir(dir)) out.add(dir);
      if (dir === scope) break;
      dir = dirname(dir);
    }
  }
  return [...out].sort();
}

/** Workspace roots (dirs with a package.json under packages/, apps/, integrations/). */
function workspaceRoots(root: string): string[] {
  return [...workspacePackages(root).values()].sort();
}

/** Tracked plus untracked-but-not-ignored files (repo-relative); falls back to [] outside git. */
function repoFiles(root: string): string[] {
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((f) => f && existsSync(join(root, f)));
}

/** Missing READMEs and READMEs inside command folders. */
export function checkStructure(root: string, files: readonly string[], roots: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  for (const dir of requiredReadmeDirs(files, roots)) {
    if (!existsSync(join(root, dir, "README.md"))) {
      problems.push({ file: `${dir}/README.md`, line: 0, message: "missing README.md (every workspace, source, test and script directory has one)" });
    }
  }
  for (const f of files) {
    if (f.endsWith("/README.md") && isInCommandFolder(dirname(f))) {
      problems.push({ file: f, line: 0, message: "README.md inside a command folder: fold it into help.txt (or the lib README) and delete it" });
    }
  }
  return problems;
}

/** Lines that carry content: non-blank and with a letter or digit (not fences, rules, table separators). */
function contentLines(markdown: string): Array<{ text: string; line: number }> {
  return markdown
    .split("\n")
    .map((raw, i) => ({ text: raw.trim(), line: i + 1 }))
    .filter((l) => /[\p{L}\p{N}]/u.test(l.text));
}

const runKey = (lines: Array<{ text: string }>, i: number) =>
  lines.slice(i, i + DUPLICATE_RUN).map((l) => l.text).join("\n");

/**
 * AGENTS.md problems: longer than AGENTS_MAX_LINES, or sharing a run of
 * DUPLICATE_RUN consecutive content lines with any README.md. `docs` are
 * repo-relative AGENTS.md / README.md paths.
 */
export function checkAgentsDocs(root: string, docs: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  const readmeRuns = new Map<string, string>();
  for (const doc of docs.filter((d) => d.endsWith("README.md"))) {
    const lines = contentLines(readFileSync(join(root, doc), "utf8"));
    for (let i = 0; i + DUPLICATE_RUN <= lines.length; i++) {
      const key = runKey(lines, i);
      if (!readmeRuns.has(key)) readmeRuns.set(key, doc);
    }
  }
  for (const doc of docs.filter((d) => d.endsWith("AGENTS.md"))) {
    const text = readFileSync(join(root, doc), "utf8");
    const total = text.replace(/\n$/, "").split("\n").length;
    if (total > AGENTS_MAX_LINES) {
      problems.push({ file: doc, line: 0, message: `${total} lines (max ${AGENTS_MAX_LINES}): AGENTS.md holds agent rules and links; move documentation to a README.md` });
    }
    const lines = contentLines(text);
    for (let i = 0; i + DUPLICATE_RUN <= lines.length; i++) {
      const readme = readmeRuns.get(runKey(lines, i));
      if (readme) {
        problems.push({ file: doc, line: lines[i]!.line, message: `${DUPLICATE_RUN}+ lines duplicated from ${readme}: link to it instead` });
        i += DUPLICATE_RUN - 1;
      }
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const { REGISTRIES } = await import("../apps/cli/bin/options");
  const index = buildIndex(
    {
      ad: REGISTRIES["integrations/automation-designer"]!,
      pd: REGISTRIES["integrations/page-designer"]!,
      rd: REGISTRIES["integrations/report-designer"]!,
      tw: REGISTRIES["integrations/teamwork"]!,
      migrate: REGISTRIES["integrations/migrations"]!,
      release: REGISTRIES["integrations/release"]!,
    },
    REGISTRIES["apps/cli"]!,
  );
  const docs = findDocs(root);
  const problems = [
    ...checkDocs(root, docs, index, workspacePackages(root)),
    ...checkStructure(root, repoFiles(root), workspaceRoots(root)),
    ...checkAgentsDocs(root, docs),
  ];
  for (const p of problems) console.error(p.line > 0 ? `${p.file}:${p.line}: ${p.message}` : `${p.file}: ${p.message}`);
  if (problems.length > 0) {
    console.error(`docs:check: ${problems.length} problem(s) in ${docs.length} docs`);
    process.exit(1);
  }
  console.log(`docs:check: ${docs.length} docs OK`);
}

if (import.meta.main) await main();
