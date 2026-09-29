#!/usr/bin/env bun
// dead-code — static dead-code report for the monorepo (TypeScript compiler API only).
//
//   bun scripts/dead-code.ts            human report
//   bun scripts/dead-code.ts --json     machine-readable report
//   bun scripts/dead-code.ts --summary  one line of counts (what `bun run check` prints)
//   bun scripts/dead-code.ts --check    exit 1 when anything is found (CI gate)
//
// What it reports:
//   1. unused exports — exported symbols nothing outside their own file uses.
//      Split into: `dead` (no use anywhere), `local-only` (used only inside the declaring
//      file → drop the `export`), `test-only` (used only by tests; production code never
//      touches it). Command modules' CommandModule members (`args`, `parseArgs`, `execute`,
//      `presentHuman`, …) are consumed by the runner through the registry namespace import
//      and count as used. A namespace import used as a value (`import * as m` then `f(m)`)
//      marks every export of that module used.
//   2. unreferenced files — not reachable from any production entry (apps/cli/bin/cli.ts,
//      non-test scripts); `test-only` when only tests reach them, `orphan` when nothing does.
//   3. package.json dependencies no file of the workspace imports, and bare imports a
//      workspace makes without declaring them.
//
// Allowlist: ALLOW below (file → export names) for deliberate public API.

import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? process.cwd());
const JSON_OUT = process.argv.includes("--json");
const CHECK = process.argv.includes("--check");
const SUMMARY = process.argv.includes("--summary");

/** Deliberate API kept although production never calls it: repo-relative file → names. */
const ALLOW: Record<string, string[]> = {
  // Test hooks: module state a unit test must reset or stub (core/testing drives the core ones).
  "packages/core/src/config/index.ts": ["reloadConfig"],
  "packages/core/src/http/dns.ts": ["setIpv4ResolverForTesting"],
  "integrations/automation-designer/lib/save/validation.ts": ["__setValidatorsForTests"],
  "integrations/automation-designer/lib/sql/api.ts": ["resetExecutableCategoryCache"],
  "integrations/teamwork/lib/api.ts": ["setTeamworkBackoffForTesting"],
  // The repo's secret scanner lives in fixtures-secrets.test.ts and is built on these.
  "scripts/fixtures/sanitize.ts": ["setScrubTerms", "findHosts", "withoutBase64", "findSecrets"],
};

/** Members of CommandModule the runner reads off a command's namespace object. */
const COMMAND_MEMBERS = new Set(["args", "parseArgs", "execute", "presentHuman", "envAware", "writes", "requiresEnv", "writesLocal", "ownsFlags", "default"]);

// ---------------------------------------------------------------- program
const cfgPath = join(ROOT, "tsconfig.json");
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const rel = (f: string) => relative(ROOT, f).split("\\").join("/");
const inRepo = (f: string) => {
  const r = rel(f);
  return !r.startsWith("..") && !r.includes("node_modules/") && !f.endsWith(".d.ts");
};
const files = program.getSourceFiles().filter((sf) => inRepo(sf.fileName));
/** Test code: tests/ dirs, *.test.ts, and core's test-support module (packages/core/src/testing). */
const isTestFile = (f: string) => /(^|\/)tests\//.test(rel(f)) || /\.test\.ts$/.test(f) || rel(f).startsWith("packages/core/src/testing/");
const isCommandIndex = (f: string) => /\/commands\/[^/]+\/index\.ts$/.test(rel(f));

// ---------------------------------------------------------------- workspaces
interface Workspace { dir: string; name: string; deps: Set<string>; pkg: any }
const workspaces: Workspace[] = [];
for (const group of ["packages", "apps", "integrations"]) {
  const g = join(ROOT, group);
  if (!existsSync(g)) continue;
  for (const d of readdirSync(g)) {
    const pj = join(g, d, "package.json");
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    workspaces.push({ dir: `${group}/${d}`, name: pkg.name, pkg, deps: new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) });
  }
}
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
workspaces.push({ dir: "", name: rootPkg.name ?? "(root)", pkg: rootPkg, deps: new Set(Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies })) });
const workspaceOf = (f: string): Workspace => {
  const r = rel(f);
  return workspaces.filter((w) => w.dir && (r === w.dir || r.startsWith(w.dir + "/"))).sort((a, b) => b.dir.length - a.dir.length)[0] ?? workspaces[workspaces.length - 1]!;
};

// ---------------------------------------------------------------- symbol usage
type UseKind = "prod" | "test";
/** original symbol → set of "file|kind" users (excluding the declaring file). */
const uses = new Map<ts.Symbol, { prod: Set<string>; test: Set<string>; local: boolean }>();
const reexported = new Map<ts.Symbol, Set<string>>();
const moduleWideUse = new Map<string, { prod: boolean; test: boolean }>(); // target file → namespace used as value

function resolveAlias(sym: ts.Symbol): ts.Symbol {
  let s = sym;
  for (let i = 0; i < 10 && s.flags & ts.SymbolFlags.Alias; i++) {
    try { s = checker.getAliasedSymbol(s); } catch { break; }
  }
  // export default of an identifier: follow to the target
  return (s as any).exportSymbol ?? s;
}
function useOf(sym: ts.Symbol) {
  let u = uses.get(sym);
  if (!u) uses.set(sym, (u = { prod: new Set(), test: new Set(), local: false }));
  return u;
}
function declFiles(sym: ts.Symbol): Set<string> {
  return new Set((sym.declarations ?? []).map((d) => d.getSourceFile().fileName));
}

for (const sf of files) {
  const kind: UseKind = isTestFile(sf.fileName) ? "test" : "prod";
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const skip =
        (p && (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p))) ||
        (p && ts.isExportSpecifier(p) && !p.parent.parent.moduleSpecifier && p.propertyName === undefined && false);
      if (!skip) {
        let raw = checker.getSymbolAtLocation(node);
        // `const { x } = await import("./m")` / `const { x } = ns`: resolve the property on the source type.
        if (p && ts.isBindingElement(p) && p.parent && ts.isObjectBindingPattern(p.parent) && (p.propertyName ?? p.name) === node) {
          const prop = checker.getTypeAtLocation(p.parent).getProperty(node.text);
          if (prop) raw = prop;
        } else if (p && ts.isBindingElement(p) && p.propertyName === node) {
          const prop = checker.getTypeAtLocation(p.parent).getProperty(node.text);
          if (prop) raw = prop;
        }
        if (raw) {
          // Re-export `export { x } from "./y"` / `export { x as y }`: record, don't count as use.
          if (p && ts.isExportSpecifier(p)) {
            const target = resolveAlias(raw);
            if (!declFiles(target).has(sf.fileName)) {
              let r = reexported.get(target);
              if (!r) reexported.set(target, (r = new Set()));
              r.add(rel(sf.fileName));
            }
          } else {
            // namespace import used as a value → whole module used
            const nsDecl = raw.flags & ts.SymbolFlags.Alias ? raw.declarations?.find(ts.isNamespaceImport) : undefined;
            if (nsDecl) {
              const isMemberAccess = (ts.isPropertyAccessExpression(p) && p.expression === node) || (ts.isQualifiedName(p) && p.left === node);
              if (!isMemberAccess) {
                const target = resolveAlias(raw);
                const tf = target.valueDeclaration?.getSourceFile().fileName ?? target.declarations?.[0]?.getSourceFile().fileName;
                if (tf) {
                  const m = moduleWideUse.get(tf) ?? { prod: false, test: false };
                  m[kind] = true;
                  moduleWideUse.set(tf, m);
                }
              }
            } else {
              const target = resolveAlias(raw);
              const isDeclName = (target.declarations ?? []).some((d) => (d as any).name === node);
              if (!isDeclName) {
                const u = useOf(target);
                if (declFiles(target).has(sf.fileName)) u.local = true;
                else u[kind].add(rel(sf.fileName));
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------- exports
interface ExportFinding { file: string; line: number; name: string; status: "dead" | "local-only" | "test-only" | "test-seam"; testUsers?: string[]; reexportedBy?: string[] }
const exportFindings: ExportFinding[] = [];
// Symbols reached through a module-wide use (namespace passed as a value, or the runner reading a
// command module's members) — including ones that module only re-exports (`export { args } from "./args"`).
const implicitlyUsed = new Set<ts.Symbol>();
for (const sf of files) {
  const modSym = checker.getSymbolAtLocation(sf);
  if (!modSym) continue;
  const wide = moduleWideUse.get(sf.fileName)?.prod;
  for (const exp of checker.getExportsOfModule(modSym)) {
    if (wide || (isCommandIndex(sf.fileName) && COMMAND_MEMBERS.has(exp.name))) implicitlyUsed.add(resolveAlias(exp));
  }
}
for (const sf of files) {
  if (isTestFile(sf.fileName) && !rel(sf.fileName).startsWith("packages/core/src/testing")) continue;
  const modSym = checker.getSymbolAtLocation(sf);
  if (!modSym) continue;
  const mw = moduleWideUse.get(sf.fileName);
  for (const exp of checker.getExportsOfModule(modSym)) {
    const target = resolveAlias(exp);
    if (!declFiles(target).has(sf.fileName)) continue; // re-export: judged at its origin
    if (isCommandIndex(sf.fileName) && COMMAND_MEMBERS.has(exp.name)) continue;
    if ((ALLOW[rel(sf.fileName)] ?? []).includes(exp.name)) continue;
    if (mw?.prod || implicitlyUsed.has(target)) continue;
    const u = uses.get(target);
    const prod = u?.prod.size ?? 0;
    const test = (u?.test.size ?? 0) + (mw?.test ? 1 : 0);
    const decl = target.declarations?.[0] ?? exp.declarations?.[0];
    const line = decl ? decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart()).line + 1 : 0;
    const base = { file: rel(sf.fileName), line, name: exp.name, reexportedBy: reexported.has(target) ? [...reexported.get(target)!] : undefined };
    const inTesting = rel(sf.fileName).startsWith("packages/core/src/testing");
    if (prod > 0) continue;
    if (test > 0) {
      // test-seam: the file uses it too and exports it for a unit test (fine); test-only: only tests use it.
      if (!inTesting) exportFindings.push({ ...base, status: u?.local ? "test-seam" : "test-only", testUsers: [...(u?.test ?? [])] });
      continue;
    }
    exportFindings.push({ ...base, status: u?.local ? "local-only" : "dead" });
  }
}

// ---------------------------------------------------------------- module graph
const graph = new Map<string, Set<string>>();
const bareImports = new Map<string, Set<string>>(); // file → package names
const host = ts.createCompilerHost(parsed.options);
function pkgName(spec: string) {
  if (spec.startsWith("node:") || spec.startsWith("bun:") || ["bun", "fs", "path", "os", "child_process", "crypto", "url", "util", "readline", "stream", "events", "net", "dns", "http", "https", "zlib", "tty", "assert", "process", "buffer", "worker_threads", "perf_hooks"].includes(spec.split("/")[0]!)) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
}
for (const sf of files) {
  const out = new Set<string>();
  const bare = new Set<string>();
  const add = (spec: string) => {
    const pn = pkgName(spec);
    if (pn) bare.add(pn);
    const r = ts.resolveModuleName(spec, sf.fileName, parsed.options, host).resolvedModule;
    if (r && inRepo(r.resolvedFileName)) out.add(r.resolvedFileName);
    else if (!r && spec.startsWith(".")) {
      // non-TS assets (help.txt …) — ignore
    }
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) add(n.arguments[0].text);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) add(n.argument.literal.text);
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) add(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  graph.set(sf.fileName, out);
  bareImports.set(sf.fileName, bare);
}
function reach(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const n of graph.get(f) ?? []) stack.push(n);
  }
  return seen;
}
const all = files.map((f) => f.fileName);
const prodEntries = all.filter((f) => rel(f) === "apps/cli/bin/cli.ts" || (rel(f).startsWith("scripts/") && !isTestFile(f)) || /\/scripts\/[^/]+\.ts$/.test(rel(f)) && !isTestFile(f));
// Files spawned by path (`Bun.spawn(["bun", join(dir, "x.ts")])`): any file whose basename
// appears as a string literal in a test counts as a test entry.
const spawnedNames = new Set<string>();
for (const sf of files) {
  if (!isTestFile(sf.fileName)) continue;
  const v = (n: ts.Node): void => { if (ts.isStringLiteralLike(n) && /\.ts$/.test(n.text)) spawnedNames.add(n.text.split("/").pop()!); ts.forEachChild(n, v); };
  v(sf);
}
const testEntries = all.filter((f) => /\.test\.ts$/.test(f) || rel(f) === "packages/core/tests/preload-belz-home.ts" || (isTestFile(f) && spawnedNames.has(f.split("/").pop()!)));
const prodReach = reach(prodEntries);
const testReach = reach(testEntries);
const fileFindings = all
  .filter((f) => !prodReach.has(f) && !isTestFile(f))
  .map((f) => ({ file: rel(f), status: testReach.has(f) ? "test-only" : "orphan" }));
const orphanTestSupport = all
  .filter((f) => isTestFile(f) && !/\.test\.ts$/.test(f) && !testReach.has(f) && !prodReach.has(f))
  .map((f) => ({ file: rel(f), status: "orphan" }));

// ---------------------------------------------------------------- deps
interface DepFinding { workspace: string; kind: "unused" | "undeclared"; dep: string; importers?: string[] }
const depFindings: DepFinding[] = [];
for (const w of workspaces) {
  const wsFiles = all.filter((f) => workspaceOf(f) === w);
  const imported = new Map<string, string[]>();
  for (const f of wsFiles) for (const p of bareImports.get(f) ?? []) imported.set(p, [...(imported.get(p) ?? []), rel(f)]);
  for (const d of w.deps) {
    if (d === "typescript" || d.startsWith("@types/")) {
      if (w.dir === "") continue; // root tooling
    }
    if (!imported.has(d)) depFindings.push({ workspace: w.dir || "(root)", kind: "unused", dep: d });
  }
  for (const [p, importers] of imported) {
    if (p === w.name) continue;
    if (!w.deps.has(p) && !(w.dir === "" && p === "typescript")) depFindings.push({ workspace: w.dir || "(root)", kind: "undeclared", dep: p, importers: importers.slice(0, 5) });
  }
}

// ---------------------------------------------------------------- output
exportFindings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const report = { exports: exportFindings, files: [...fileFindings, ...orphanTestSupport], deps: depFindings };
const countOf = (s: string) => exportFindings.filter((e) => e.status === s).length;
if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (SUMMARY) {
  console.log(
    `dead-code: exports dead ${countOf("dead")}, test-only ${countOf("test-only")}, local-only ${countOf("local-only")}; ` +
      `unreachable files ${report.files.length}; dependency problems ${depFindings.length}` +
      (CHECK ? "" : " (report only; `bun scripts/dead-code.ts` lists them)"),
  );
} else {
  const by = (s: string) => exportFindings.filter((e) => e.status === s);
  for (const s of ["dead", "test-only", "local-only", "test-seam"] as const) {
    const list = by(s);
    console.log(`\n## exports: ${s} (${list.length})`);
    for (const e of list) console.log(`${e.file}:${e.line}  ${e.name}${e.reexportedBy ? `  [re-exported by ${e.reexportedBy.join(", ")}]` : ""}${e.testUsers ? `  [tests: ${e.testUsers.map((t) => t.split("/").pop()).join(", ")}]` : ""}`);
  }
  console.log(`\n## files not reachable from production entries (${report.files.length})`);
  for (const f of report.files) console.log(`${f.file}  (${f.status})`);
  console.log(`\n## dependencies (${depFindings.length})`);
  for (const d of depFindings) console.log(`${d.workspace}: ${d.kind} ${d.dep}${d.importers ? `  ← ${d.importers.join(", ")}` : ""}`);
}
if (CHECK && (exportFindings.some((e) => e.status === "dead" || e.status === "test-only") || report.files.length || depFindings.length)) process.exit(1);
