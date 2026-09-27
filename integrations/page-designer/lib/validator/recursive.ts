// `pd validate --recursive`: validate a page AND every symbol it uses
// (transitively), plus the page ↔ symbol checks from pd-review §3b that need
// both sides:
//   SYMBOL_NOT_FOUND      a used symbol does not exist in this env
//   SYMBOL_UNKNOWN_INPUT  an instance binds `[x]` the symbol does not declare
//   SYMBOL_UNKNOWN_EVENT  an instance handles an event the symbol does not declare
//   SYMBOL_NESTING_DEPTH  a symbol chain deeper than 3 (reported on the root)
// Symbols are the DRAFT components with the instance's exact name — what the
// author edits — fetched through the page cache. Each symbol is validated once
// however many times it is used.

import { CliError } from "@belzabar/core";
import { walkParsed } from "../parser/nodes";
import { parsePage } from "../parser/index";
import type { HydratedPage, SymbolNode, ValidationIssue } from "../types/common";
import type { RawPageResponse } from "../types/wire";
import { validateHydrated } from "./index";

export const MAX_SYMBOL_DEPTH = 3;

export interface SymbolFetcher {
  /** The DRAFT component named `name`, or null when there is none. */
  byName(name: string): Promise<RawPageResponse | null>;
}

export interface RecursiveEntry {
  name: string;
  id: string;
  entityType: "PAGE" | "COMPONENT";
  /** 0 = the root; 1 = a symbol the root uses directly; … (shortest chain). */
  depth: number;
  /** Symbols this entry uses directly (unique names). */
  uses: string[];
  issues: ValidationIssue[];
  errorCount: number;
  warnCount: number;
}

export interface RecursiveReport {
  entries: RecursiveEntry[];
  /** Longest symbol chain from the root (names, root first). */
  longestChain: string[];
  errorCount: number;
  warnCount: number;
  /** Symbols that could not be fetched (network / ambiguity), not "missing". */
  fetchErrors: Array<{ name: string; message: string }>;
}

/** Instance nodes (not the entity's own root) that reference a symbol. */
function symbolInstances(page: HydratedPage): SymbolNode[] {
  const out: SymbolNode[] = [];
  for (const child of page.layout.children) {
    walkParsed(child, (n) => {
      if (n.kind === "SYMBOL" && n.symbolName.trim()) out.push(n);
    });
  }
  return out;
}

/** SYMBOL_UNKNOWN_INPUT / SYMBOL_UNKNOWN_EVENT for the instances in `page` of the symbols in `symbols`. */
export function symbolInterfaceIssues(page: HydratedPage, symbols: Map<string, HydratedPage | null>): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const inst of symbolInstances(page)) {
    const name = inst.symbolName.trim();
    const sym = symbols.get(name);
    if (!sym) continue;
    const inputs = new Set(sym.inputs.filter((i): i is string => typeof i === "string").map((i) => i.trim()));
    const events = new Set(sym.events.filter((e): e is string => typeof e === "string").map((e) => e.trim()));
    const unknownIn = inst.inputBindings.map((b) => b.prop.trim()).filter((p) => !inputs.has(p));
    const unknownEv = inst.eventWires.map((e) => e.trim()).filter((e) => !events.has(e));
    if (unknownIn.length) {
      out.push({
        code: "SYMBOL_UNKNOWN_INPUT",
        severity: "warn",
        message: `Instance ${inst.nodeId} of "${name}" binds input(s) ${unknownIn.join(", ")} that "${name}" does not declare (declared: ${[...inputs].join(", ") || "none"})`,
        nodeId: inst.nodeId,
        nodeName: name,
      });
    }
    if (unknownEv.length) {
      out.push({
        code: "SYMBOL_UNKNOWN_EVENT",
        severity: "warn",
        message: `Instance ${inst.nodeId} of "${name}" handles event(s) ${unknownEv.join(", ")} that "${name}" does not emit (declared: ${[...events].join(", ") || "none"})`,
        nodeId: inst.nodeId,
        nodeName: name,
      });
    }
  }
  return out;
}

function usedNames(page: HydratedPage): string[] {
  return [...new Set(symbolInstances(page).map((n) => n.symbolName.trim()))];
}

function message(err: unknown): string {
  return err instanceof CliError || err instanceof Error ? err.message : String(err);
}

export async function validateRecursive(rootRaw: RawPageResponse, fetcher: SymbolFetcher): Promise<RecursiveReport> {
  const root = parsePage(rootRaw);
  const pages = new Map<string, HydratedPage | null>(); // symbol name → page (null = not found)
  const fetchErrors: RecursiveReport["fetchErrors"] = [];
  const depthOf = new Map<string, number>();

  // BFS over symbol names; each fetched once.
  let frontier = usedNames(root);
  for (const n of frontier) depthOf.set(n, 1);
  while (frontier.length) {
    const next: string[] = [];
    const fetched = await Promise.all(
      frontier.map(async (name) => {
        try {
          const raw = await fetcher.byName(name);
          return { name, page: raw ? parsePage(raw) : null };
        } catch (err) {
          fetchErrors.push({ name, message: message(err) });
          return { name, page: undefined };
        }
      }),
    );
    for (const { name, page } of fetched) {
      if (page === undefined) continue; // fetch error: neither validated nor "missing"
      pages.set(name, page);
      if (!page) continue;
      for (const child of usedNames(page)) {
        if (depthOf.has(child) || child === root.name) continue;
        depthOf.set(child, depthOf.get(name)! + 1);
        next.push(child);
      }
    }
    frontier = next;
  }

  const entryFor = (page: HydratedPage, depth: number, extra: ValidationIssue[]): RecursiveEntry => {
    const issues = [...validateHydrated(page), ...symbolInterfaceIssues(page, pages), ...extra];
    return {
      name: page.name,
      id: page.id,
      entityType: page.entityType,
      depth,
      uses: usedNames(page),
      issues,
      errorCount: issues.filter((i) => i.severity === "error").length,
      warnCount: issues.filter((i) => i.severity === "warn").length,
    };
  };

  // Longest chain (DFS, cycle-safe) for SYMBOL_NESTING_DEPTH.
  const longest = (name: string, seen: Set<string>): string[] => {
    const page = pages.get(name);
    if (!page || seen.has(name)) return [name];
    seen.add(name);
    let best: string[] = [];
    for (const c of usedNames(page)) {
      const chain = longest(c, seen);
      if (chain.length > best.length) best = chain;
    }
    seen.delete(name);
    return [name, ...best];
  };
  let longestChain = [root.name];
  for (const c of usedNames(root)) {
    const chain = [root.name, ...longest(c, new Set([root.name]))];
    if (chain.length > longestChain.length) longestChain = chain;
  }

  const rootExtra: ValidationIssue[] = [];
  // Missing symbols are reported on every entity that uses them.
  const missingIssues = (page: HydratedPage): ValidationIssue[] =>
    usedNames(page)
      .filter((n) => pages.has(n) && pages.get(n) === null)
      .map((n) => ({
        code: "SYMBOL_NOT_FOUND",
        severity: "warn" as const,
        message: `Symbol "${n}" is used but no component with that name exists in this environment`,
        nodeName: n,
      }));
  if (longestChain.length - 1 > MAX_SYMBOL_DEPTH) {
    rootExtra.push({
      code: "SYMBOL_NESTING_DEPTH",
      severity: "warn",
      message: `Symbol chain is ${longestChain.length - 1} levels deep (max ${MAX_SYMBOL_DEPTH}): ${longestChain.join(" → ")}`,
    });
  }

  const entries: RecursiveEntry[] = [entryFor(root, 0, [...missingIssues(root), ...rootExtra])];
  const ordered = [...pages.entries()]
    .filter((e): e is [string, HydratedPage] => e[1] !== null)
    .sort((a, b) => depthOf.get(a[0])! - depthOf.get(b[0])! || a[0].localeCompare(b[0]));
  for (const [name, page] of ordered) entries.push(entryFor(page, depthOf.get(name)!, missingIssues(page)));

  return {
    entries,
    longestChain,
    errorCount: entries.reduce((n, e) => n + e.errorCount, 0),
    warnCount: entries.reduce((n, e) => n + e.warnCount, 0),
    fetchErrors,
  };
}
