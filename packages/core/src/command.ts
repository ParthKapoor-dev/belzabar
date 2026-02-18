import type { Environment } from "./types";

export type OutputMode = "human" | "llm";

export interface CommandError {
  code: string;
  message: string;
  details?: unknown;
}

export interface CommandResultMeta {
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
  kv(key: string, value: unknown): void;
  table(headers: string[], rows: unknown[][]): void;
  object(value: unknown): void;
}

export interface CommandContext {
  outputMode: OutputMode;
  env: Environment;
  binaryName: string;
  commandName: string;
  warn(message: string): void;
}

export interface CommandModule<TArgs = unknown, TData = unknown> {
  schema?: string;
  version?: string;
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
