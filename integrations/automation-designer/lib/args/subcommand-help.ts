// `wi-impl ad <cmd> <sub> --help`: the command's help.txt narrowed to one
// subcommand (CommandModule.helpFor). The help.txt layout it reads:
//   - a `Subcommands:` section of entries at two-space indent (continuation
//     lines indented deeper); only the asked one is kept;
//   - section headers that end in `(<sub>, <sub>, …):`, e.g. `Flags (run):`,
//     are kept only for a listed subcommand (`(all subcommands)` always);
//   - `Examples:` keeps the lines that run the asked subcommand;
//   - every other section is kept as is.

/** The help for `sub` (the first argument, when it is not a flag), or `help` unchanged. */
export function subcommandHelp(help: string, args: string[], command: string): string {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) return help;
  const lines = help.split("\n");
  const sections: Array<{ header: string | null; body: string[] }> = [{ header: null, body: [] }];
  for (const line of lines) {
    if (/^\S.*:\s*$/.test(line) && !line.startsWith("Usage:")) sections.push({ header: line, body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  const subs = sections.find((s) => s.header === "Subcommands:");
  if (!subs) return help;
  const entries = splitEntries(subs.body);
  const mine = entries.find((e) => e[0]!.trim().split(/\s+/)[0] === sub);
  if (!mine) return help;

  const out: string[] = [];
  for (const s of sections) {
    if (s.header === null) {
      out.push(...s.body.map((l) => l.replace(new RegExp(`^Usage: ${escape(command)} <subcommand>`), `Usage: ${command} ${sub}`)));
      continue;
    }
    if (s.header === "Subcommands:") {
      out.push(s.header, ...mine, "");
      continue;
    }
    const scoped = /\(([^)]*)\):\s*$/.exec(s.header);
    if (scoped) {
      const names = scoped[1]!.split(",").map((n) => n.trim());
      if (!names.includes(sub) && scoped[1] !== "all subcommands") continue;
    }
    if (s.header.startsWith("Examples")) {
      const runs = new RegExp(`${escape(command)} ${escape(sub)}(\\s|$)`);
      const kept = s.body.filter((l) => runs.test(l));
      if (kept.length > 0) out.push(s.header, ...kept, "");
      continue;
    }
    out.push(s.header, ...s.body);
  }
  out.push(`(${command} --help shows every subcommand.)`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** Split a `Subcommands:` body into entries (an entry line at two-space indent plus its continuation). */
function splitEntries(body: string[]): string[][] {
  const entries: string[][] = [];
  for (const line of body) {
    if (/^ {2}\S/.test(line)) entries.push([line]);
    else if (line.trim() && entries.length > 0) entries[entries.length - 1]!.push(line);
  }
  return entries;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
