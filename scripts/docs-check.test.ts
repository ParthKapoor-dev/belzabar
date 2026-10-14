// Unit tests for scripts/docs-check.ts (the `bun run docs:check` gate).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AGENTS_MAX_LINES,
  buildIndex,
  checkAgentsDocs,
  checkCommand,
  checkDocs,
  checkStructure,
  commandCandidates,
  extractSnippets,
  findDocs,
  isFixtureDir,
  isInCommandFolder,
  pathCandidates,
  requiredReadmeDirs,
  workspacePackages,
} from "./docs-check";

const mod = (args?: unknown) => ({ module: args === undefined ? {} : { args } });
const subs = (names: string[], options: Record<string, unknown> = {}) => ({
  kind: "subcommands",
  subcommands: Object.fromEntries(names.map((n) => [n, {}])),
  options,
});

const INDEX = buildIndex(
  {
    ad: { show: mod(), sql: mod(subs(["run", "explain"], { aliases: { tui: "run" } })), find: mod(subs(["methods"], { default: "methods" })) },
    pd: { show: mod() },
  },
  { cache: mod(subs(["invalidate", "prune-local"])), envs: mod() },
);

describe("extractSnippets", () => {
  test("code spans, fenced lines and link targets, with line numbers", () => {
    const md = ["Use `a/b.ts` and [x](c/d.md).", "```bash", "belz ad show 1", "```", "`x` docs-check:ignore `y/z`"].join("\n");
    expect(extractSnippets(md)).toEqual([
      { text: "a/b.ts", line: 1, kind: "code" },
      { text: "c/d.md", line: 1, kind: "link" },
      { text: "belz ad show 1", line: 3, kind: "code" },
    ]);
  });

  test("a link inside a code span is not a link", () => {
    expect(extractSnippets("`[a](b/c)`")).toEqual([{ text: "[a](b/c)", line: 1, kind: "code" }]);
  });
});

describe("pathCandidates", () => {
  const code = (text: string) => pathCandidates({ text, line: 1, kind: "code" });

  test("keeps multi-segment paths and strips punctuation, :line and ./", () => {
    expect(code("see ./lib/save/verify.ts:12, then lib/api/")).toEqual(["lib/save/verify.ts", "lib/api"]);
  });

  test("skips single names, placeholders, urls, absolute and home paths", () => {
    expect(code("registry.ts lib/ <env>/x.json a/*.ts ~/.wi-impl/config.json /rest/api https://x.y/z a/{b,c}")).toEqual([]);
  });
});

describe("commandCandidates / checkCommand", () => {
  test("extracts words after belz up to a flag or placeholder", () => {
    expect(commandCandidates("belz ad show <uuid> --llm && belz cache prune-local --yes")).toEqual([["ad", "show"], ["cache", "prune-local"]]);
    expect(commandCandidates("bun run belz:install; ./belz --help-full; [belz pd write] saved")).toEqual([]);
  });

  test("registered commands pass", () => {
    for (const words of [["ad", "show"], ["ad"], ["ad", "sql", "explain"], ["ad", "sql", "tui"], ["ad", "find", "anything"], ["cache", "prune-local"], ["envs"]]) {
      expect(checkCommand(INDEX, words)).toBeNull();
    }
  });

  test("unknown namespaces, commands and strict subcommands fail", () => {
    expect(checkCommand(INDEX, ["frobnicate"])).toContain("unknown command `belz frobnicate`");
    expect(checkCommand(INDEX, ["pd", "write"])).toContain("unknown command `belz pd write`");
    expect(checkCommand(INDEX, ["ad", "sql", "drop"])).toContain("unknown subcommand");
    expect(checkCommand(INDEX, ["cache", "clear"])).toContain("unknown subcommand");
  });
});

describe("checkDocs on a temp repo", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "docs-check-"));
    mkdirSync(join(root, "integrations/ad/lib/save"), { recursive: true });
    mkdirSync(join(root, "integrations/ad/node_modules/x"), { recursive: true });
    mkdirSync(join(root, ".claude/skill"), { recursive: true });
    writeFileSync(join(root, "integrations/ad/lib/save/verify.ts"), "");
    writeFileSync(join(root, "integrations/ad/package.json"), JSON.stringify({ name: "@belzabar/ad" }));
    writeFileSync(join(root, "integrations/ad/node_modules/x/README.md"), "`lib/nope.ts`");
    writeFileSync(join(root, ".claude/skill/README.md"), "`lib/nope.ts`");
    writeFileSync(
      join(root, "integrations/ad/AGENTS.md"),
      [
        "`lib/save/verify.ts` `lib/save/verify` `integrations/ad/lib/save` `chain/v2`", // ok (doc-relative, extension-less, root-relative, unanchored)
        "`lib/save/missing.ts`", // 2: missing (doc-relative)
        "`integrations/pd/x.ts`", // 3: missing (root-relative)
        "`@belzabar/ad/lib/trace` `@belzabar/nope`", // 4: unknown package
        "`belz ad show <uuid>` `belz frobnicate`", // 5: unknown command
        "[ok](../ad/lib/save/verify.ts) [bad](../ad/lib/gone.ts)", // 6: missing link
      ].join("\n"),
    );
    writeFileSync(join(root, "README.md"), "```\nbelz pd write x\n```\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("findDocs skips .claude/ and node_modules/", () => {
    expect(findDocs(root)).toEqual(["README.md", "integrations/ad/AGENTS.md"]);
  });

  test("reports each stale path, package and command with file:line", () => {
    const problems = checkDocs(root, findDocs(root), INDEX, workspacePackages(root));
    expect(problems.map((p) => `${p.file}:${p.line}: ${p.message}`)).toEqual([
      "README.md:2: unknown command `belz pd write`",
      "integrations/ad/AGENTS.md:2: missing path lib/save/missing.ts",
      "integrations/ad/AGENTS.md:3: missing path integrations/pd/x.ts",
      "integrations/ad/AGENTS.md:4: unknown package @belzabar/nope",
      "integrations/ad/AGENTS.md:5: unknown command `belz frobnicate`",
      "integrations/ad/AGENTS.md:6: missing path ../ad/lib/gone.ts",
    ]);
  });
});

describe("README coverage", () => {
  const FILES = [
    "integrations/ad/package.json",
    "integrations/ad/registry.ts",
    "integrations/ad/lib/save/verify.ts",
    "integrations/ad/commands/registry.ts",
    "integrations/ad/commands/show/index.ts",
    "integrations/ad/commands/sql/tui/view.ts",
    "integrations/ad/tests/unit/a.test.ts",
    "integrations/ad/tests/fixtures/real-v1/x.json",
    "integrations/ad/node_modules/x/index.js",
    "scripts/fixtures/capture.ts",
    "cloud/setup.sh",
    "README.md",
  ];

  test("command folders and test fixture dirs are recognised", () => {
    expect(isInCommandFolder("integrations/ad/commands")).toBe(false);
    expect(isInCommandFolder("integrations/ad/commands/show")).toBe(true);
    expect(isInCommandFolder("integrations/ad/commands/sql/tui")).toBe(true);
    expect(isFixtureDir("integrations/ad/tests/fixtures/real-v1")).toBe(true);
    expect(isFixtureDir("scripts/fixtures")).toBe(false);
  });

  test("workspace roots, scripts/ and every dir below them, minus command folders, fixtures and deps", () => {
    expect(requiredReadmeDirs(FILES, ["integrations/ad"])).toEqual([
      "integrations/ad",
      "integrations/ad/commands",
      "integrations/ad/lib",
      "integrations/ad/lib/save",
      "integrations/ad/tests",
      "integrations/ad/tests/unit",
      "scripts",
      "scripts/fixtures",
    ]);
  });

  test("checkStructure reports missing READMEs and READMEs in command folders", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-check-structure-"));
    try {
      const files = ["integrations/ad/package.json", "integrations/ad/lib/a.ts", "integrations/ad/commands/show/index.ts", "integrations/ad/commands/show/README.md", "integrations/ad/commands/README.md", "integrations/ad/README.md"];
      for (const f of files) {
        mkdirSync(join(root, f, ".."), { recursive: true });
        writeFileSync(join(root, f), "");
      }
      const problems = checkStructure(root, files, ["integrations/ad"]).map((p) => p.file);
      expect(problems).toEqual(["integrations/ad/lib/README.md", "integrations/ad/commands/show/README.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("thin AGENTS.md", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "docs-check-agents-"));
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "a/README.md"), ["# A", "", "Line one of the doc.", "Line two of the doc.", "", "Line three of the doc.", "Other."].join("\n"));
    // Blank lines and punctuation-only lines (fences, rules) do not break or make a run.
    writeFileSync(join(root, "a/AGENTS.md"), ["# Rules", "Line one of the doc.", "", "Line two of the doc.", "---", "Line three of the doc.", "```", "```", "```"].join("\n"));
    writeFileSync(join(root, "b/AGENTS.md"), Array.from({ length: AGENTS_MAX_LINES + 1 }, (_, i) => `rule ${i}`).join("\n") + "\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("flags duplicated runs and over-long files", () => {
    const problems = checkAgentsDocs(root, ["a/AGENTS.md", "a/README.md", "b/AGENTS.md"]);
    expect(problems.map((p) => `${p.file}:${p.line}`)).toEqual(["a/AGENTS.md:2", "b/AGENTS.md:0"]);
    expect(problems[0]!.message).toContain("a/README.md");
    expect(problems[1]!.message).toContain(`${AGENTS_MAX_LINES + 1} lines`);
  });
});
