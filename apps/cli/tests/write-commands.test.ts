// D6 guard, registry-wide: every command (or sub-action) that mutates a remote
// environment declares `writes` (so the runner demands an explicit --env), and
// every command that only writes local state declares `writesLocal`. A few read
// sub-actions are pinned too, so `writes: true` on everything cannot pass.
//
// Cases whose fix is in flight elsewhere become test.todo while they still fail
// (they flip to real tests automatically once the module declares `writes`).
import { describe, expect, test } from "bun:test";
import type { CommandContext, CommandModule } from "@belzabar/core";
import { REGISTRIES } from "../bin/options";

const UUID = "0123456789abcdef0123456789abcdef";

type Kind = "writes" | "writesLocal" | "reads";
interface Case {
  owner: string;
  command: string;
  argv: string[];
  kind: Kind;
  /** Set while another stage owns the fix: a failing case is a test.todo carrying this note. */
  todo?: string;
}

const AD = "integrations/automation-designer";
const PD = "integrations/page-designer";

const CASES: Case[] = [
  // ── Automation Designer ──
  { owner: AD, command: "save", argv: [UUID], kind: "writes" },
  { owner: AD, command: "publish", argv: [UUID], kind: "writes" },
  { owner: AD, command: "create", argv: ["--category", "Test-Parth", "--spec", "s.json"], kind: "writes" },
  { owner: AD, command: "delete", argv: [UUID], kind: "writes" },
  { owner: AD, command: "import", argv: ["x.json"], kind: "writes" },
  { owner: AD, command: "category", argv: ["create", "belz_tst"], kind: "writes" },
  { owner: AD, command: "changelog", argv: [UUID, "--note", "n"], kind: "writes" },
  { owner: AD, command: "changelog", argv: [UUID], kind: "reads" },
  { owner: AD, command: "test-case", argv: ["create", UUID, "--file", "tc.json"], kind: "writes" },
  { owner: AD, command: "test-case", argv: ["update", UUID, "1", "--file", "tc.json"], kind: "writes" },
  { owner: AD, command: "test-case", argv: ["delete", "1"], kind: "writes" },
  { owner: AD, command: "test-case", argv: ["bulk", UUID, "--file", "tc.json"], kind: "writes" },
  { owner: AD, command: "test-case", argv: ["run-suite", UUID], kind: "writes" },
  { owner: AD, command: "test-case", argv: ["delete-suite", "1"], kind: "writes" },
  { owner: AD, command: "test-case", argv: ["list", UUID], kind: "reads" },
  { owner: AD, command: "history", argv: ["restore", UUID, "--version", "2"], kind: "writes" },
  { owner: AD, command: "history", argv: ["list", UUID], kind: "reads" },
  { owner: AD, command: "sql", argv: ["update", "UPDATE t SET a = 1", "--db", "x"], kind: "writes" },
  { owner: AD, command: "sql", argv: ["insert", "INSERT INTO t (a) VALUES (1)", "--db", "x"], kind: "writes" },
  { owner: AD, command: "sql", argv: ["modify", "ALTER TABLE t ADD COLUMN b INT", "--db", "x"], kind: "writes" },
  { owner: AD, command: "sql", argv: ["run", "select 1"], kind: "reads" },
  { owner: AD, command: "sql", argv: ["tui"], kind: "writes" },
  { owner: AD, command: "test", argv: [UUID], kind: "writes" },
  { owner: AD, command: "run", argv: [UUID], kind: "writes" },
  { owner: AD, command: "run-suites", argv: [], kind: "writes" },
  // ── Page Designer ──
  { owner: PD, command: "save", argv: [UUID], kind: "writes" },
  { owner: PD, command: "publish", argv: [UUID], kind: "writes" },
  { owner: PD, command: "lock", argv: ["acquire", UUID], kind: "writes" },
  { owner: PD, command: "lock", argv: ["release", UUID], kind: "writes" },
  { owner: PD, command: "history", argv: ["restore", UUID, "--version", "3", "--yes"], kind: "writes" },
  { owner: PD, command: "history", argv: ["list", UUID], kind: "reads" },
  // ── Teamwork / migrations / release ──
  { owner: "integrations/teamwork", command: "add-comment", argv: ["123", "--body", "hi"], kind: "writes" },
  { owner: "integrations/migrations", command: "run", argv: [], kind: "writes" },
  { owner: "integrations/release", command: "freeze", argv: [], kind: "writesLocal" },
  { owner: "integrations/release", command: "matrix", argv: [], kind: "writesLocal" },
];

const ctx: CommandContext = {
  outputMode: "human",
  env: { name: "t-dev", baseUrl: "https://t-dev.test" } as CommandContext["env"],
  envExplicit: true,
  verbose: false,
  binaryName: "belz",
  commandName: "",
  warn: () => {},
};

function moduleOf(owner: string, command: string): CommandModule<unknown, unknown> {
  const entry = REGISTRIES[owner]?.[command];
  if (!entry) throw new Error(`${owner} has no command '${command}'`);
  const mod = entry.module as { default?: CommandModule<unknown, unknown> } & CommandModule<unknown, unknown>;
  return mod.default ?? mod;
}

/** Does the command, for this argv, declare a remote write? (Same evaluation as the runner.) */
async function declaresWrite(c: Case): Promise<boolean> {
  const m = moduleOf(c.owner, c.command);
  if (typeof m.writes !== "function") return m.writes === true;
  const parsed = m.parseArgs ? await m.parseArgs(c.argv, { ...ctx, commandName: c.command }) : c.argv;
  return (m.writes as (a: unknown) => boolean)(parsed);
}

async function check(c: Case): Promise<void> {
  if (c.kind === "writesLocal") {
    expect(moduleOf(c.owner, c.command).writesLocal).toBe(true);
    return;
  }
  expect(await declaresWrite(c)).toBe(c.kind === "writes");
}

async function passes(c: Case): Promise<boolean> {
  try {
    await check(c);
    return true;
  } catch {
    return false;
  }
}

describe("write commands declare writes / writesLocal (D6)", async () => {
  for (const c of CASES) {
    const name = `${c.owner.replace("integrations/", "")} ${c.command} ${c.argv.slice(0, 2).join(" ")}`.trim() + ` → ${c.kind}`;
    if (c.todo && !(await passes(c))) {
      test.todo(`${name} (${c.todo})`, () => check(c));
      continue;
    }
    test(name, () => check(c));
  }
});
