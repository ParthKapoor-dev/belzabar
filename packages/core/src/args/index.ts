// core/args — declarative argument parsing for every wi-impl command.
//
//   export const args = defineArgs({
//     command: "wi-impl ad show",
//     positionals: [{ name: "uuid", required: true }],
//     flags: {
//       step: { type: "number", integer: true, min: 1, alias: ["--service-detail"] },
//       full: { type: "boolean" },
//     },
//   });
//   const { flags, positionals } = args.parse(argv);   // typed; CliError on bad input
//
// Convention: every command module exports its def as `args` (a namespace
// import of the command's index.ts exposes it), so the runner and the
// help/desc drift test can inspect it.

export * from "./spec";
export {
  defineArgs,
  defineSubcommands,
  specsOf,
  acceptedFlags,
  declaresFlag,
  suggest,
} from "./parse";
