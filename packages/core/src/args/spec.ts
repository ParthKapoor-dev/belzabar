// Declarative argument specs: the types behind `defineArgs` / `defineSubcommands`.
//
// A spec lists a command's positionals and flags. `parse(argv)` turns argv into
// typed values and throws a `CliError` with a stable code on anything it does not
// understand (see ARG_ERROR_CODES). The spec object itself stays inspectable so
// tests can check help.txt / desc.txt against it.

/** Flags the runner owns. They are always "known" and never need declaring. */
export const GLOBAL_FLAGS = ["--llm", "--env", "-e", "-v", "--verbose", "--help", "-h", "--help-full"] as const;

/** Stable error codes raised by the parser. */
export const ARG_ERROR_CODES = {
  UNKNOWN_FLAG: "UNKNOWN_FLAG",
  MISSING_VALUE: "MISSING_VALUE",
  INVALID_VALUE: "INVALID_VALUE",
  MISSING_FLAG: "MISSING_FLAG",
  MISSING_ARGUMENT: "MISSING_ARGUMENT",
  UNEXPECTED_ARGUMENT: "UNEXPECTED_ARGUMENT",
  CONFLICTING_FLAGS: "CONFLICTING_FLAGS",
  DUPLICATE_FLAG: "DUPLICATE_FLAG",
  UNKNOWN_SUBCOMMAND: "UNKNOWN_SUBCOMMAND",
  MISSING_SUBCOMMAND: "MISSING_SUBCOMMAND",
} as const;
export type ArgErrorCode = keyof typeof ARG_ERROR_CODES;

interface BaseFlag {
  /** Extra spellings, dashes included: `["--service-detail"]`, `["-o"]`. */
  alias?: readonly string[];
  description?: string;
  /** Must be given. (Booleans cannot be required.) */
  required?: boolean;
  /** Collect every occurrence into an array (value flags only). */
  repeatable?: boolean;
  /** Override the error code / message when a required flag is missing. */
  missingCode?: string;
  missingMessage?: string;
}

interface BooleanFlagSpec extends BaseFlag {
  type: "boolean";
}

interface StringFlagSpec extends BaseFlag {
  type: "string";
  default?: string;
  /** Accept a following value that looks like a flag (`--pattern -x`). Default false. */
  allowDashValue?: boolean;
  /** Accept an empty string value (`--name ""`, `--name=`). Default false (MISSING_VALUE). */
  allowEmpty?: boolean;
}

interface NumberFlagSpec extends BaseFlag {
  type: "number";
  default?: number;
  integer?: boolean;
  min?: number;
  max?: number;
}

interface EnumFlagSpec extends BaseFlag {
  type: "enum";
  values: readonly string[];
  default?: string;
  /** Match values case-insensitively; the canonical spelling is returned. Default true. */
  caseInsensitive?: boolean;
}

export type FlagSpec = BooleanFlagSpec | StringFlagSpec | NumberFlagSpec | EnumFlagSpec;
export type FlagsSpec = Record<string, FlagSpec>;

interface PositionalSpec {
  name: string;
  required?: boolean;
  /** Collects every remaining positional (must be last). */
  variadic?: boolean;
  description?: string;
  missingCode?: string;
  missingMessage?: string;
}

export interface ArgsSpec {
  /** For error messages: `belz ad show`. */
  command?: string;
  positionals?: readonly PositionalSpec[];
  flags?: FlagsSpec;
  /** Groups of flag keys of which at most one may be given. */
  exclusive?: readonly (readonly string[])[];
  /** Groups of flag keys of which at least one must be given. */
  requireOneOf?: readonly (readonly string[])[];
  /**
   * Override error codes (`{ UNKNOWN_FLAG: "MIGRATE_UNKNOWN_FLAG" }`). Only for
   * commands whose codes predate this module; new specs leave it unset.
   */
  codes?: Partial<Record<ArgErrorCode, string>>;
  /** Extra positionals are collected into `extra` instead of being an error. */
  allowExtraPositionals?: boolean;
}

// ── Type-level mapping: spec → parsed values ────────────────────────────────

type CamelCase<S extends string> = S extends `${infer H}-${infer T}`
  ? `${H}${Capitalize<CamelCase<T>>}`
  : S;

type ScalarOf<F extends FlagSpec> = F extends { type: "number" }
  ? number
  : F extends { type: "enum"; values: readonly (infer V)[] }
    ? V
    : string;

type FlagValue<F extends FlagSpec> = F extends { type: "boolean" }
  ? boolean
  : F extends { repeatable: true }
    ? ScalarOf<F>[]
    : F extends { required: true }
      ? ScalarOf<F>
      : F extends { default: unknown }
        ? ScalarOf<F>
        : ScalarOf<F> | undefined;

type FlagValues<F extends FlagsSpec | undefined> = F extends FlagsSpec
  ? { -readonly [K in keyof F & string as CamelCase<K>]: FlagValue<F[K]> }
  : {};

type PositionalValue<P extends PositionalSpec> = P extends { variadic: true }
  ? string[]
  : P extends { required: true }
    ? string
    : string | undefined;

type PositionalValues<P extends readonly PositionalSpec[] | undefined> = P extends readonly PositionalSpec[]
  ? { -readonly [E in P[number] as CamelCase<E["name"]>]: PositionalValue<E> }
  : {};

export interface ParsedArgs<S extends ArgsSpec> {
  flags: FlagValues<S["flags"]>;
  positionals: PositionalValues<S["positionals"]>;
  /** Positionals beyond the spec (only with `allowExtraPositionals`). */
  extra: string[];
  /** Tokens after a `--` terminator (also fed to positionals). */
  afterDoubleDash: string[];
  /** Flag keys (spec keys, not camelCased) that were given explicitly. */
  provided: Set<string>;
}

export interface ArgsDef<S extends ArgsSpec = ArgsSpec> {
  readonly kind: "args";
  readonly spec: S;
  parse(argv: readonly string[]): ParsedArgs<S>;
}

export type SubcommandsSpec = Record<string, ArgsSpec>;

export type ParsedSubcommand<M extends SubcommandsSpec> = {
  [K in keyof M & string]: { subcommand: K } & ParsedArgs<M[K]>;
}[keyof M & string];

export interface SubcommandsOptions<M extends SubcommandsSpec> {
  command?: string;
  /** Used when argv[0] is not a subcommand name (argv is then parsed whole). */
  default?: keyof M & string;
  /** Alternate names: `{ ls: "list" }`. */
  aliases?: Record<string, keyof M & string>;
  codes?: Partial<Record<ArgErrorCode, string>>;
  missingMessage?: string;
}

export interface SubcommandsDef<M extends SubcommandsSpec = SubcommandsSpec> {
  readonly kind: "subcommands";
  readonly subcommands: M;
  readonly options: SubcommandsOptions<M>;
  parse(argv: readonly string[]): ParsedSubcommand<M>;
}

export type AnyArgsDef = ArgsDef<any> | SubcommandsDef<any>;
