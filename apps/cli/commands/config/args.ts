// `belz config` argument spec (core defineSubcommands). Kept apart from index.ts
// so the parser can be tested without the config/auth imports.

import { CliError, defineSubcommands } from "@belzabar/core";

export const args = defineSubcommands(
  {
    get: {},
    token: { flags: { refresh: { type: "boolean" } } },
    edit: {},
  },
  {
    command: "belz config",
    missingMessage: "Usage: belz config <subcommand>\nSubcommands: get, token, edit\nRun 'belz config --help' for details.",
  },
);

type ParsedConfigArgs = { action: "get" } | { action: "token"; refresh: boolean } | { action: "edit" };

export function parseConfigArgs(argv: string[]): ParsedConfigArgs {
  let parsed;
  try {
    parsed = args.parse(argv);
  } catch (e) {
    if (e instanceof CliError && e.code === "UNKNOWN_SUBCOMMAND" && (argv[0] === "envs" || argv[0] === "env")) {
      throw new CliError(`${e.message} To list environments, run 'belz envs'.`, { code: e.code, details: e.details });
    }
    throw e;
  }
  if (parsed.subcommand === "token") return { action: "token", refresh: parsed.flags.refresh };
  return { action: parsed.subcommand };
}
