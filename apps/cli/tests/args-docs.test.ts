// Every command declares its arguments with core `defineArgs` / `defineSubcommands`
// (exported from its index.ts as `args`), and its help.txt / desc.txt agree with
// that spec: every declared flag is documented, every documented flag exists,
// help.txt starts with `Usage: belz …`, and every desc.txt line reads
// `belz <ns> <cmd> …  :->  …` (it is what `belz --help-full` prints).
import { describe, expect, test } from "bun:test";
import { checkCommandDocs, type AnyArgsDef } from "@belzabar/core";
import { REGISTRIES } from "../bin/options";

const NAMESPACE: Record<string, string> = {
  "integrations/automation-designer": "ad",
  "integrations/page-designer": "pd",
  "integrations/teamwork": "tw",
  "integrations/migrations": "migrate",
  "integrations/release": "release",
  "apps/cli": "",
};

/** Commands whose migration is waiting on another agent's commit (delete entries as they land). */
const PENDING = new Set<string>(["belz setup"]);

describe("args spec ↔ help.txt / desc.txt", () => {
  for (const [owner, registry] of Object.entries(REGISTRIES)) {
    const ns = NAMESPACE[owner];
    for (const [name, entry] of Object.entries(registry)) {
      const invocation = ns ? `belz ${ns} ${name}` : `belz ${name}`;
      if (PENDING.has(invocation) && !(entry.module as { args?: unknown }).args) {
        test.todo(`${invocation} (pending)`);
        continue;
      }
      test(invocation, () => {
        const mod = entry.module as { args?: AnyArgsDef; parseArgs?: unknown; default?: { parseArgs?: unknown } };
        expect(mod.args, `${owner}/commands/${name}/index.ts must export \`args\``).toBeDefined();
        expect(["args", "subcommands"]).toContain(mod.args!.kind);
        expect(typeof (mod.default ?? mod).parseArgs).toBe("function");
        const problems = checkCommandDocs({ invocation, def: mod.args!, help: entry.help, desc: entry.desc });
        expect(problems).toEqual([]);
      });
    }
  }
});
