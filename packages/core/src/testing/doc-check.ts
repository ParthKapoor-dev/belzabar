// Check a command's help.txt / desc.txt against its args spec, so the docs the
// agents read (`wi-impl … --help`, `wi-impl --help-full`) never drift from the parser.

import { acceptedFlags, specsOf } from "../args/parse";
import { GLOBAL_FLAGS, type AnyArgsDef } from "../args/spec";

/** `--flag` tokens mentioned in a text (long flags only). */
export function flagsMentioned(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w-])(--[a-zA-Z][a-zA-Z0-9-]*)/g)) out.add(m[1]!);
  return [...out];
}

interface DocCheckInput {
  /** `wi-impl ad show` / `wi-impl envs`. */
  invocation: string;
  def: AnyArgsDef;
  help: string;
  desc: string;
}

/** Problems found (empty = in sync). */
export function checkCommandDocs({ invocation, def, help, desc }: DocCheckInput): string[] {
  const problems: string[] = [];
  const accepted = acceptedFlags(def);
  const isKnown = (f: string) => accepted.has(f) || (GLOBAL_FLAGS as readonly string[]).includes(f);

  // 1. Every declared spelling is documented in help.txt.
  for (const spec of specsOf(def)) {
    for (const [key, flag] of Object.entries(spec.flags ?? {})) {
      for (const t of [`--${key}`, ...(flag.alias ?? [])]) {
        const re = new RegExp(`(?<![\\w-])${t.replace(/[-]/g, "\\-")}(?![\\w-])`);
        if (!re.test(help)) problems.push(`help.txt does not document ${t}`);
      }
    }
  }

  // 2. Every flag the docs mention exists.
  for (const [file, text] of [["help.txt", help], ["desc.txt", desc]] as const) {
    for (const f of flagsMentioned(text)) {
      if (!isKnown(f)) problems.push(`${file} mentions ${f}, which the parser does not accept`);
    }
  }

  // 3. Format.
  const firstLine = help.split("\n").find(l => l.trim() !== "") ?? "";
  if (!firstLine.startsWith(`Usage: ${invocation}`)) {
    problems.push(`help.txt must start with 'Usage: ${invocation}' (got '${firstLine}')`);
  }
  const lines = desc.split("\n").filter(l => l.trim() !== "");
  if (lines.length === 0) problems.push("desc.txt is empty");
  for (const line of lines) {
    const ok =
      (line === invocation || line.startsWith(`${invocation} `) || line.startsWith(`${invocation}  `)) &&
      /\S\s+:->\s+\S/.test(line);
    if (!ok) problems.push(`desc.txt line not in '${invocation} …  :->  …' format: '${line}'`);
  }
  return [...new Set(problems)];
}
