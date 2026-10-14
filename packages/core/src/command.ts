import type { Environment } from "./types";

export type OutputMode = "human" | "llm";

export interface CommandError {
  code: string;
  message: string;
  /** Always an object on the wire: the runner wraps strings as `{ text }` (see `normalizeDetails`). */
  details?: unknown;
}

interface CommandResultMeta {
  [key: string]: unknown;
}

export type CommandResult<TData = unknown> =
  | {
      ok: true;
      data: TData;
      meta?: CommandResultMeta;
    }
  | {
      ok: false;
      error: CommandError;
      data?: unknown;
      meta?: CommandResultMeta;
    };

export interface CommandEnvelope<TData = unknown> {
  schema: string;
  version: string;
  ok: boolean;
  command: string;
  data: TData | null;
  error: CommandError | null;
  meta: CommandResultMeta;
}

export interface HumanPresenterHelpers {
  section(title: string): void;
  text(message: string): void;
  success(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  step(message: string): void;
  note(title: string, body: string): void;
  kv(key: string, value: unknown): void;
  table(headers: string[], rows: unknown[][]): void;
  object(value: unknown): void;
}

export interface CommandContext {
  outputMode: OutputMode;
  env: Environment;
  /** True when `--env` was given explicitly (otherwise `env` is the default env). */
  envExplicit: boolean;
  /** Runner debug logging (`-v/--verbose` in global position, or WI_IMPL_VERBOSE=1). */
  verbose: boolean;
  binaryName: string;
  commandName: string;
  warn(message: string): void;
}

export interface CommandModule<TArgs = unknown, TData = unknown> {
  /**
   * The command talks to the active AD/PD environment. Default true. When false
   * (teamwork, jenkins/migrate, release, local config…), the envelope omits
   * `meta.env` and the command never needs `--env`.
   */
  envAware?: boolean;
  /**
   * The command changes state on the target environment. Such commands refuse to
   * run on the default env: `--env` must be given explicitly, else
   * `ENV_REQUIRED_FOR_WRITE`. A function is evaluated on the parsed args (for
   * commands with read and write sub-actions). Enforced only for env-aware
   * commands (a non-env-aware writer such as `migrate run` names its target
   * through its own arguments).
   */
  writes?: boolean | ((args: TArgs) => boolean);
  /**
   * The command does not write here, but it reads the target env for a write it
   * previews (the `--dry-run` of save/create, `test-case sync` without
   * `--apply`). Like `writes`, it refuses to run on the default env, so a
   * preview can never silently read a different project than the write would
   * hit. `ENV_REQUIRED_FOR_WRITE`. Enforced only for env-aware commands.
   */
  requiresEnv?: boolean | ((args: TArgs) => boolean);
  /**
   * The command writes local state only (files, ledgers, ~/.wi-impl). Informational:
   * unlike `writes`, it does not require an explicit `--env`.
   */
  writesLocal?: boolean;
  /**
   * Global-flag tokens this command declares for itself (currently only
   * `-v`/`--verbose` can be claimed). When such a token appears after the
   * command name, it is passed to `parseArgs` instead of switching on runner
   * debug logging. The runner also derives this from the command module's
   * exported `args` spec (core/args `declaresFlag`).
   */
  ownsFlags?: readonly string[];
  parseArgs?: (args: string[], context: CommandContext) => TArgs | Promise<TArgs>;
  execute: (args: TArgs, context: CommandContext) => CommandResult<TData> | Promise<CommandResult<TData>>;
  presentHuman?: (envelope: CommandEnvelope<TData>, ui: HumanPresenterHelpers) => void;
}

export class CliError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(message: string, options?: { code?: string; details?: unknown; exitCode?: number }) {
    super(message);
    this.name = "CliError";
    this.code = options?.code ?? "CLI_ERROR";
    this.details = options?.details;
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function ok<TData>(data: TData, meta: CommandResultMeta = {}): CommandResult<TData> {
  return { ok: true, data, meta };
}

export function fail(
  code: string,
  message: string,
  options?: { details?: unknown; data?: unknown; meta?: CommandResultMeta }
): CommandResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      details: options?.details,
    },
    data: options?.data,
    meta: options?.meta,
  };
}

/**
 * A failure that still carries a result — e.g. a validator that found errors,
 * a preflight that did not pass, a lookup that found nothing. The envelope is
 * `ok:false` (exit 1) with `data` set, and the human presenter still runs on it.
 */
export function failWithData<TData>(
  code: string,
  message: string,
  data: TData,
  options?: { details?: unknown; meta?: CommandResultMeta }
): CommandResult<never> {
  return fail(code, message, { ...options, data });
}
