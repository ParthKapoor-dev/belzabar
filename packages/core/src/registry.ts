// Static command registries.
//
// Each integration exports a hand-maintained `registry` (see e.g.
// integrations/teamwork/registry.ts): command name → the command module plus its
// help.txt / desc.txt, imported as text so the compiled binary embeds them.

/** One registered command. */
interface RegisteredCommand {
  /** Namespace import of `commands/<name>/index.ts` (default export = the CommandModule). */
  module: unknown;
  /** Contents of `commands/<name>/help.txt` (`wi-impl … <name> --help`). */
  help: string;
  /** Contents of `commands/<name>/desc.txt` (one block of `wi-impl --help-full`). */
  desc: string;
}

export type CommandRegistry = Record<string, RegisteredCommand>;

/** Sorted command names of a registry. */
export function registryNames(registry: CommandRegistry): string[] {
  return Object.keys(registry).sort();
}

/** name → command module map, as the runner's `commands` / `topLevel` expect (sorted). */
export function registryModules(registry: CommandRegistry): Record<string, any> {
  const out: Record<string, any> = {};
  for (const name of registryNames(registry)) out[name] = registry[name]!.module;
  return out;
}

/** A runner help resolver backed by the registry's embedded help text. */
export function registryHelpResolver(registry: CommandRegistry) {
  return async (cmd: string): Promise<string | null> =>
    Object.hasOwn(registry, cmd) ? registry[cmd]!.help.trimEnd() : null;
}
