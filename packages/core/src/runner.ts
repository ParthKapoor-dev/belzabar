import { Config, NO_ENV, inAgentSession, noEnvSelectedError } from "./config";
import {
  CliError,
  type CommandContext,
  type CommandEnvelope,
  type CommandError,
  type CommandModule,
  type CommandResult,
  type HumanPresenterHelpers,
} from "./command";
import { printErr, prompts, renderHuman, renderLLM, setOutputMode } from "./ui";
import { ui as theme, symbols, wordmark } from "./theme";
import { verboseEnabled, vlog } from "./verbose";
import { ENVELOPE_VERSION } from "./envelope";
import { declaresFlag, type AnyArgsDef } from "./args";

interface NamespaceDefinition {
  name: string;
  description: string;
  /** Sub-command map (ad, pd style). Mutually exclusive with `command`. */
  commands?: Record<string, any>;
  /** Passthrough: a single CommandModule that handles its own sub-routing (migrate style). */
  command?: any;
  helpDir?: string;
  helpResolver?: (cmd: string) => Promise<string | null>;
  /** Default for the namespace's commands when they don't set `envAware` (default true). */
  envAware?: boolean;
}

/** Build identity, printed by `belz --version`. */
interface BuildInfo {
  version: string;
  /** Short git SHA the binary was built from ("unknown" outside a checkout). */
  sha: string;
  /** The checkout had uncommitted changes at build time. */
  dirty?: boolean;
  builtAt?: string;
}

export interface NamespacedCliOptions {
  name: string;
  description: string;
  binaryName: string;
  namespaces: Record<string, NamespaceDefinition>;
  topLevel: Record<string, any>;
  topLevelHelpDir?: string;
  topLevelHelpResolver?: (cmd: string) => Promise<string | null>;
  /** Per top-level command default for `envAware` (the command's own field wins). */
  topLevelEnvAware?: Record<string, boolean>;
  /** Enables `--version` (as the first argument). */
  build?: BuildInfo;
  /**
   * `belz --help-full`: the full command reference. Honoured only as the
   * first argument after the global flags (never after a command name or
   * `--`); in `--llm` mode it is a `belz.help` envelope with `data.text`.
   */
  /**
   * `belz --help-full [<namespace>] [--index]`: the whole reference, one
   * namespace's part, or a one-line-per-command index. Returns null for an
   * unknown namespace.
   */
  helpFull?: (opts?: HelpFullOptions) => string | null;
  /**
   * Extra sentence for an UNKNOWN_COMMAND / UNKNOWN_SUBCOMMAND / UNKNOWN_FLAG error (the CLI
   * suggests `belz update` when a newer release may know it). Null adds nothing.
   */
  unknownHint?: () => string | null;
}

const UNKNOWN_CODES = new Set(["UNKNOWN_COMMAND", "UNKNOWN_SUBCOMMAND", "UNKNOWN_FLAG"]);

/** Append `options.unknownHint()` to an unknown command/flag error's message. */
function withUnknownHint(outcome: RunOutcome, hint: NamespacedCliOptions["unknownHint"]): RunOutcome {
  if (!hint) return outcome;
  const error = outcome.kind === "envelope" ? outcome.envelope.error : null;
  const unknown = outcome.kind === "print" ? outcome.unknown === true : !!error && UNKNOWN_CODES.has(error.code);
  if (!unknown) return outcome;
  let text: string | null = null;
  try { text = hint(); } catch { /* a hint never breaks the error */ }
  if (!text) return outcome;
  if (outcome.kind === "print") {
    return { ...outcome, print: () => { outcome.print(); printErr(theme.faint(`${symbols.arrow} ${text}`)); } };
  }
  const message = /[.!?]$/.test(error!.message) ? `${error!.message} ${text}` : `${error!.message}. ${text}`;
  return { ...outcome, envelope: { ...outcome.envelope, error: { ...error!, message } } };
}

// ── Shared internals ────────────────────────────────────────────────────────

// ── Stdio flushing ──────────────────────────────────────────────────────────
//
// Bun (1.2.x) silently drops `console.log` output beyond the pipe buffer (64 KiB)
// once `process.stdout` has been touched, and `process.exit()` discards anything
// still queued. Both truncate `--llm` JSON when piped (`belz … --llm | jq`).
// Fix: when a stream is not a TTY, route console output through
// `stream.write()` (which queues instead of dropping) and, before exiting, await
// the callback of the last write so the queue has fully drained.

type StdStream = NodeJS.WriteStream;
const pendingWrites = new Map<StdStream, Promise<void>>();
let stdioGuardInstalled = false;

function guardedWrite(stream: StdStream, text: string): void {
  const done = new Promise<void>(resolve => {
    try {
      // The callback fires once the chunk is handed to the OS (or on error).
      stream.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
  const prev = pendingWrites.get(stream) ?? Promise.resolve();
  pendingWrites.set(stream, Promise.all([prev, done]).then(() => {}));
}

/** Route console output through queued stream writes when stdout/stderr are pipes. Idempotent. */
export function installStdioGuard(): void {
  if (stdioGuardInstalled) return;
  stdioGuardInstalled = true;
  const { format } = require("node:util") as typeof import("node:util");
  // A closed reader (`| head`) must not crash the process or hang the flush.
  process.stdout.on?.("error", () => {});
  process.stderr.on?.("error", () => {});
  if (!process.stdout.isTTY) {
    const out = (...a: unknown[]) => guardedWrite(process.stdout, format(...a) + "\n");
    console.log = out;
    console.info = out;
  }
  if (!process.stderr.isTTY) {
    const err = (...a: unknown[]) => guardedWrite(process.stderr, format(...a) + "\n");
    console.error = err;
    console.warn = err;
  }
}

/** Resolve once every console write made through the guard has been handed to the OS. */
async function flushStdio(): Promise<void> {
  // Note: a zero-length write's callback can fire before earlier queued writes
  // drain, so we wait on every tracked write rather than appending a marker.
  await Promise.all([...pendingWrites.values()]);
}

/** Flush stdout/stderr, then exit. Use instead of a bare `process.exit()`. */
export async function flushAndExit(code: number): Promise<never> {
  process.exitCode = code;
  await flushStdio();
  process.exit(code);
}

// ── Global flags ────────────────────────────────────────────────────────────

/** A `-v`/`--verbose` token removed by the global parser, and where it stood. */
interface VerboseToken {
  /** Index in `GlobalFlags.args` the token stood before (== args.length when trailing). */
  index: number;
  token: string;
}

interface GlobalFlags {
  /** argv with the global flags removed (everything from `--` onward is kept verbatim). */
  args: string[];
  outputMode: "human" | "llm";
  verbose: boolean;
  /** Every `-v/--verbose` removed, with its position — handed back to commands that own the flag. */
  verboseTokens: VerboseToken[];
  envName: string | null;
  error: { code: string; message: string } | null;
}

const VERBOSE_TOKENS = new Set(["-v", "--verbose"]);

/**
 * Pure parser for the global flags `--llm`, `--human`, `-v/--verbose`, `-e/--env <name>`,
 * `--env=<name>`, `-e=<name>`. `defaultMode` is the output without `--llm`/`--human` (the
 * runner passes "llm" inside an agent session); both flags together are an error.
 * Parsing stops at `--`: everything after it (including a literal `--llm` or
 * `-v`) is left for the command. A missing value, or `--env` given more than
 * once, is an error.
 */
export function parseGlobalFlags(argv: string[], defaultMode: "human" | "llm" = "human"): GlobalFlags {
  const args: string[] = [];
  const verboseTokens: VerboseToken[] = [];
  let explicitMode: "human" | "llm" | null = null;
  let envName: string | null = null;
  let error: GlobalFlags["error"] = null;
  const setError = (code: string, message: string) => { if (!error) error = { code, message }; };
  const setEnv = (value: string, flag: string) => {
    if (envName !== null) {
      setError(
        "INVALID_ARGS",
        value === envName
          ? `${flag} given more than once.`
          : `Conflicting --env values '${envName}' and '${value}'.`
      );
      return;
    }
    envName = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      args.push(...argv.slice(i));
      break;
    }
    if (a === "--llm" || a === "--human") {
      const mode = a === "--llm" ? "llm" : "human";
      if (explicitMode !== null && explicitMode !== mode) setError("INVALID_ARGS", "--llm and --human cannot be combined.");
      explicitMode = mode;
      continue;
    }
    if (VERBOSE_TOKENS.has(a)) { verboseTokens.push({ index: args.length, token: a }); continue; }
    if (a === "--env" || a === "-e") {
      const next = argv[i + 1];
      if (next === undefined || next === "--" || next.startsWith("-")) {
        setError("MISSING_ENV_ARG", "--env requires an environment name (e.g. --env dev).");
        continue;
      }
      setEnv(next, a);
      i++;
      continue;
    }
    const eq = a.startsWith("--env=") ? "--env=" : a.startsWith("-e=") ? "-e=" : null;
    if (eq) {
      const value = a.slice(eq.length);
      if (!value) {
        setError("MISSING_ENV_ARG", "--env requires an environment name (e.g. --env dev).");
        continue;
      }
      setEnv(value, "--env");
      continue;
    }
    args.push(a);
  }

  const outputMode = explicitMode ?? defaultMode;
  return { args, outputMode, verbose: verboseTokens.length > 0, verboseTokens, envName, error };
}

/** Process-wide global state for one invocation, threaded into dispatch. */
interface GlobalContext {
  /** `--env` was given explicitly. */
  envExplicit: boolean;
  verboseTokens: VerboseToken[];
  /** BELZ_VERBOSE as it was before the global flags were applied. */
  verboseEnvBefore: string | undefined;
  /** No usable default env: the default (BELZ_ENV / config.json `defaultEnv`) is not configured, or none is selected. */
  defaultEnvError: { code: string; message: string } | null;
  startedAt: number;
}

/**
 * Select the default env for a run without `--env`: BELZ_ENV > config.json
 * `defaultEnv` > the only configured env (core/config owns the precedence).
 * Returns an error when the default names an env that is not configured
 * (INVALID_ENV) or when nothing selects an env (ENV_NOT_SELECTED).
 */
function applyDefaultEnv(): { code: string; message: string } | null {
  Config.resetActiveEnv();
  if (Config.envSource === "none") {
    const e = noEnvSelectedError();
    return { code: e.code, message: e.message };
  }
  const source =
    Config.envSource === "BELZ_ENV" ? "BELZ_ENV" : Config.envSource === "config" ? "config.json defaultEnv" : "default";
  const name = Config.activeEnv.name;
  return Config.getAllEnvs()[name] ? null : unknownDefault(name, source);
}

/**
 * Ask which env a write without `--env` targets (interactive terminals only): the default env
 * first, then every other configured env. Returns the chosen env name; cancelling aborts.
 */
async function chooseWriteEnv(defaultName: string, writes: boolean): Promise<string | null> {
  const names = Object.keys(Config.getAllEnvs());
  if (!names.includes(defaultName)) return null;
  const others = names.filter(n => n !== defaultName);
  return prompts.select<string>({
    message: writes ? "Write to which environment?" : "Preview the write against which environment?",
    options: [
      { label: defaultName, value: defaultName, hint: `default (${envSourceLabel()})` },
      ...others.map(n => ({ label: n, value: n })),
    ],
    initialValue: defaultName,
  });
}

/** `meta.envSource`: where the env came from. `default` = config.json `defaultEnv` or the only configured env. */
type MetaEnvSource = "flag" | "BELZ_ENV" | "default";

function metaEnvSource(envExplicit: boolean): MetaEnvSource {
  if (envExplicit) return "flag";
  return Config.envSource === "BELZ_ENV" ? "BELZ_ENV" : "default";
}

function envSourceLabel(): string {
  return Config.envSource === "BELZ_ENV" ? "from BELZ_ENV" : Config.envSource === "config" ? "config.json defaultEnv" : "the only configured env";
}

function unknownDefault(name: string, source: string): { code: string; message: string } {
  return {
    code: "INVALID_ENV",
    message:
      `Default env '${name}' (from ${source}) is not configured. ` +
      `Available: ${Object.keys(Config.getAllEnvs()).join(", ")}. Pass --env <name> or fix the default.`,
  };
}

/**
 * Parse the global flags and apply them to process-wide state (output mode,
 * verbose, active env). Does not touch stdio, so it is safe to call in-process
 * (see `dispatchNamespaced` / `core/testing` `runCommand`).
 */
export function resolveGlobalFlags(argv: string[]): {
  args: string[];
  outputMode: "human" | "llm";
  envName: string | null;
  envError: { code: string; message: string } | null;
  globals: GlobalContext;
} {
  const startedAt = Date.now();
  const parsed = parseGlobalFlags(argv, inAgentSession() ? "llm" : "human");
  const verboseEnvBefore = process.env.BELZ_VERBOSE;
  if (parsed.verbose) process.env.BELZ_VERBOSE = "1";
  setOutputMode(parsed.outputMode);

  let envError = parsed.error;
  let defaultEnvError: GlobalContext["defaultEnvError"] = null;
  if (!envError && parsed.envName !== null) {
    try {
      Config.setActiveEnv(parsed.envName);
    } catch (e: any) {
      envError = { code: "INVALID_ENV", message: stripErrorPrefix(e.message) };
    }
  } else if (!envError) {
    defaultEnvError = applyDefaultEnv();
  }

  return {
    args: parsed.args,
    outputMode: parsed.outputMode,
    envName: parsed.envName,
    envError,
    globals: {
      envExplicit: parsed.envName !== null,
      verboseTokens: parsed.verboseTokens,
      verboseEnvBefore,
      defaultEnvError,
      startedAt,
    },
  };
}

// ── Outcomes ────────────────────────────────────────────────────────────────
//
// Dispatch is pure with respect to process lifetime: it returns a RunOutcome
// (an envelope, or a human-only printer) plus the exit code, and never calls
// process.exit. `runNamespacedCli` renders it and exits; tests render it
// in-process (core/testing `runCommand`).

export type RunOutcome =
  | {
      kind: "envelope";
      exitCode: number;
      outputMode: "human" | "llm";
      envelope: CommandEnvelope;
      presenter?: (envelope: CommandEnvelope<unknown>, ui: HumanPresenterHelpers) => void;
    }
  | { kind: "print"; exitCode: number; print: () => void; unknown?: true };

function envelopeOutcome(
  outputMode: "human" | "llm",
  envelope: CommandEnvelope,
  exitCode: number,
  presenter?: (envelope: CommandEnvelope<unknown>, ui: HumanPresenterHelpers) => void
): RunOutcome {
  return { kind: "envelope", exitCode, outputMode, envelope, presenter };
}

function printOutcome(exitCode: number, print: () => void): RunOutcome {
  return { kind: "print", exitCode, print };
}

/** Human output for an unknown command (exit 1); `withUnknownHint` can add its hint. */
function unknownPrintOutcome(print: () => void): RunOutcome {
  return { kind: "print", exitCode: 1, print, unknown: true };
}

/** Write an outcome to stdout/stderr (no exit). Human errors and warnings go to stderr. */
export function renderOutcome(outcome: RunOutcome): void {
  if (outcome.kind === "print") {
    // Help / --help-full / --version are reference text that agents read from a
    // pipe: plain whenever the stream is not a TTY or NO_COLOR is set — even
    // under FORCE_COLOR, which agent harnesses export.
    const plain = (tty: boolean | undefined) => !tty || process.env.NO_COLOR !== undefined;
    const [log, error] = [console.log, console.error];
    const strip = (write: (...a: unknown[]) => void, on: boolean) =>
      on ? (...a: unknown[]) => write(...a.map((x) => (typeof x === "string" ? stripAnsi(x) : x))) : write;
    console.log = strip(log, plain(process.stdout.isTTY));
    console.error = strip(error, plain(process.stderr.isTTY));
    try {
      outcome.print();
    } finally {
      console.log = log;
      console.error = error;
    }
    return;
  }
  const { outputMode, envelope, presenter } = outcome;
  if (outputMode === "llm") {
    renderLLM(envelope);
  } else {
    renderHuman(envelope, presenter);
  }
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

async function finishOutcome(outcome: RunOutcome): Promise<never> {
  renderOutcome(outcome);
  return flushAndExit(outcome.exitCode);
}

/** True when `-h`/`--help` appears anywhere before a `--` terminator. */
export function hasHelpFlag(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "--help" || a === "-h") return true;
  }
  return false;
}

// ── Envelope naming ─────────────────────────────────────────────────────────

/** `belz ad` → `belz`. */
function rootName(binaryName: string): string {
  return binaryName.split(" ")[0] || binaryName;
}

/** Schema namespace for a dispatch level: `belz ad` → `ad`, `belz` → `belz`. */
function schemaNamespace(binaryName: string): string {
  const parts = binaryName.split(" ").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("-") : (parts[0] ?? binaryName);
}

/** Envelope for runner-level outcomes (help, unknown command, bad global flags): `belz.help` / `belz.runner`. */
function runnerEnvelope(
  binaryName: string,
  kind: "help" | "runner" | "version",
  command: string,
  startedAt: number,
  body: { ok: true; data: unknown } | { ok: false; error: CommandError }
): CommandEnvelope {
  return {
    schema: `${rootName(binaryName)}.${kind}`,
    version: ENVELOPE_VERSION,
    ok: body.ok,
    command,
    data: body.ok ? body.data : null,
    error: body.ok ? null : normalizeCommandError(body.error),
    meta: { durationMs: Date.now() - startedAt },
  };
}

/** Runner-level error outcome for a global-flag error (bad/duplicate `--env`). */
export function globalErrorOutcome(
  binaryName: string,
  outputMode: "human" | "llm",
  error: { code: string; message: string },
  startedAt: number
): RunOutcome {
  return envelopeOutcome(outputMode, runnerEnvelope(binaryName, "runner", "global", startedAt, { ok: false, error }), 1);
}

// ── Command-owned global flags ─────────────────────────────────────

/** Global-flag tokens a command claims: `ownsFlags`, plus flags declared in the module's exported `args` spec. */
function ownedGlobalTokens(moduleNs: unknown, command: CommandModule<any, any>): Set<string> {
  const out = new Set<string>(command.ownsFlags ?? []);
  const spec = (moduleNs as { args?: AnyArgsDef } | undefined)?.args;
  if (spec) for (const token of VERBOSE_TOKENS) if (declaresFlag(spec, token)) out.add(token);
  return out;
}

/** Re-insert tokens (positions in `args` coordinates) into `args`. */
function reinsert(args: string[], tokens: VerboseToken[]): string[] {
  const sorted = [...tokens].sort((a, b) => a.index - b.index);
  const out: string[] = [];
  let t = 0;
  for (let i = 0; i < args.length; i++) {
    while (t < sorted.length && sorted[t]!.index === i) out.push(sorted[t++]!.token);
    out.push(args[i]!);
  }
  while (t < sorted.length) out.push(sorted[t++]!.token);
  return out;
}

interface DispatchOptions {
  globals?: GlobalContext;
  /** Index of `args[0]` (the command name) within the globally-parsed argv (for re-inserting owned flags). */
  base?: number;
  /** Namespace default for `envAware`. */
  envAware?: boolean;
}

/**
 * Run one command from `commandMap` (`args[0]` is its name) and return the
 * outcome. Never exits the process. @internal — exported for core/testing.
 */
export async function dispatchCommand(
  args: string[],
  commandMap: Record<string, any>,
  outputMode: "human" | "llm",
  binaryName: string,
  helpResolver?: (cmd: string) => Promise<string | null>,
  opts: DispatchOptions = {}
): Promise<RunOutcome> {
  const startedAt = opts.globals?.startedAt ?? Date.now();
  const warnings: string[] = [];
  const commandName = args[0];

  const listCommandsHuman = () => {
    console.log();
    console.log(`${theme.heading("usage")}  ${theme.accent(binaryName)} <command> [args]`);
    console.log();
    console.log(theme.heading("commands"));
    Object.keys(commandMap).forEach(cmd => console.log(`  ${theme.accent(cmd)}`));
    console.log();
    console.log(theme.faint(`${symbols.arrow} ${binaryName} <command> --help  for details`));
  };

  if (!commandName || commandName === "--help" || commandName === "-h") {
    if (outputMode === "llm") {
      return envelopeOutcome(
        outputMode,
        runnerEnvelope(binaryName, "help", "help", startedAt, {
          ok: true,
          data: { binaryName, commands: Object.keys(commandMap) },
        }),
        0
      );
    }
    return printOutcome(0, listCommandsHuman);
  }

  const commandModule = Object.hasOwn(commandMap, commandName) ? commandMap[commandName] : undefined;
  const command = (commandModule?.default ?? commandModule) as CommandModule<any, any>;

  if (!command) {
    if (outputMode === "llm") {
      return envelopeOutcome(
        outputMode,
        runnerEnvelope(binaryName, "runner", commandName, startedAt, {
          ok: false,
          error: { code: "UNKNOWN_COMMAND", message: `Unknown command: ${binaryName} ${commandName}` },
        }),
        1
      );
    }
    return unknownPrintOutcome(() => {
      printErr(theme.err(`Unknown command: ${theme.bold(`${binaryName} ${commandName}`)}`));
      listCommandsHuman();
    });
  }

  if (hasHelpFlag(args.slice(1))) {
    let helpText: string | null = null;
    if (helpResolver) {
      helpText = await helpResolver(commandName);
    }
    if (outputMode === "llm") {
      return envelopeOutcome(
        outputMode,
        runnerEnvelope(binaryName, "help", commandName, startedAt, {
          ok: true,
          data: { help: helpText ?? `No help file found for '${commandName}'.` },
        }),
        0
      );
    }
    return printOutcome(0, () => console.log(helpText ?? `No help file found for '${commandName}'.`));
  }

  // -v/--verbose after the command name belongs to the command when it declares it.
  let commandArgs = args.slice(1);
  const globals = opts.globals;
  if (globals && globals.verboseTokens.length > 0) {
    const base = opts.base ?? 0;
    const owned = ownedGlobalTokens(commandModule, command);
    const mine = globals.verboseTokens.filter(t => t.index > base && owned.has(t.token));
    if (mine.length > 0) {
      commandArgs = reinsert(commandArgs, mine.map(t => ({ index: t.index - base - 1, token: t.token })));
      // Only tokens the command did not claim switch on runner debug logging.
      if (mine.length === globals.verboseTokens.length) {
        if (globals.verboseEnvBefore === undefined) delete process.env.BELZ_VERBOSE;
        else process.env.BELZ_VERBOSE = globals.verboseEnvBefore;
      }
    }
  }

  const envAware = command.envAware ?? opts.envAware ?? true;
  let activeEnv = Config.activeEnv;
  let envExplicit = globals?.envExplicit ?? false;
  // No env selected (ENV_NOT_SELECTED): the envelope carries no meta.env.
  let envForMeta = envAware && activeEnv.name !== NO_ENV ? activeEnv.name : null;
  let envSourceForMeta = envForMeta !== null ? metaEnvSource(envExplicit) : null;
  const schema = `${schemaNamespace(binaryName)}.${commandName}`;

  const commandContext: CommandContext = {
    outputMode,
    env: activeEnv,
    envExplicit,
    verbose: verboseEnabled(),
    binaryName,
    commandName,
    warn: (message: string) => { warnings.push(message); },
  };

  try {
    if (typeof command.execute !== "function") {
      throw new CliError(`Command '${commandName}' does not export an execute() function.`, {
        code: "INVALID_COMMAND_MODULE",
      });
    }
    if (envAware && globals?.defaultEnvError && !envExplicit) {
      throw new CliError(globals.defaultEnvError.message, { code: globals.defaultEnvError.code });
    }

    const parsedArgs = command.parseArgs
      ? await command.parseArgs(commandArgs, commandContext)
      : commandArgs;

    // Only env-aware commands take their target from --env; others (migrate run:
    // profile → envs) name their target through their own arguments.
    const flag = (v: boolean | ((a: unknown) => boolean) | undefined) =>
      typeof v === "function" ? v(parsedArgs) : v === true;
    const writes = envAware && flag(command.writes as never);
    const previewsWrite = envAware && !writes && flag(command.requiresEnv as never);
    if ((writes || previewsWrite) && !envExplicit) {
      // A person at a terminal picks the target here (default env preselected);
      // agents (--llm) and scripts (no TTY) must still name it with --env.
      const chosen = outputMode === "human" && process.stdin.isTTY && process.stderr.isTTY
        ? await chooseWriteEnv(activeEnv.name, writes)
        : null;
      if (chosen === null) {
        const what = writes ? "writes to an environment" : "previews a write by reading the target environment";
        throw new CliError(
          `'${binaryName} ${commandName}' ${what}, so --env is required ` +
            `(the default env is '${activeEnv.name}'; to target it, add --env ${activeEnv.name}).`,
          { code: "ENV_REQUIRED_FOR_WRITE", details: { defaultEnv: activeEnv.name, dryRun: previewsWrite } }
        );
      }
      Config.setActiveEnv(chosen);
      activeEnv = Config.activeEnv;
      envExplicit = true;
      envForMeta = activeEnv.name;
      envSourceForMeta = "flag";
      commandContext.env = activeEnv;
      commandContext.envExplicit = true;
    }
    if (writes && outputMode === "human") {
      printErr(theme.faint(`${symbols.arrow} target env: ${activeEnv.name} (${activeEnv.baseUrl})`));
    } else if (envAware && !envExplicit && outputMode === "human") {
      // Reads may use the default env, but never silently.
      printErr(theme.faint(`${symbols.arrow} env: ${activeEnv.name} (${envSourceLabel()}; pass --env to choose)`));
    }

    const result = await command.execute(parsedArgs, commandContext);
    const envelope = toEnvelope(schema, commandName, result, startedAt, envForMeta, warnings, envSourceForMeta);
    return envelopeOutcome(outputMode, envelope, envelope.ok ? 0 : 1, command.presentHuman);
  } catch (error: unknown) {
    const normalizedError = normalizeError(error);
    const failureResult: CommandResult = { ok: false, error: normalizedError };
    const envelope = toEnvelope(schema, commandName, failureResult, startedAt, envForMeta, warnings, envSourceForMeta);
    const exitCode = error instanceof CliError && error.exitCode > 0 ? error.exitCode : 1;
    return envelopeOutcome(outputMode, envelope, exitCode, command.presentHuman);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runNamespacedCli(
  argv: string[],
  options: NamespacedCliOptions
): Promise<void> {
  installStdioGuard();
  await finishOutcome(withUnknownHint(await dispatchNamespaced(argv.slice(2), options), options.unknownHint));
}

/** `belz 0.1.0 (abc1234)` */
export interface HelpFullOptions {
  /** Only this namespace (`ad`, `pd`, … or `top` for top-level commands). */
  namespace?: string;
  /** One line per command instead of every invocation variant. */
  index?: boolean;
}

function formatBuildInfo(binaryName: string, build: BuildInfo): string {
  const sha = build.sha + (build.dirty ? "-dirty" : "");
  return `${binaryName} ${build.version} (${sha}${build.builtAt ? `, built ${build.builtAt}` : ""})`;
}

/**
 * Route `argv` (global flags included, without the `bun script` prefix) through
 * the namespaced CLI and return the outcome. Never exits the process.
 * @internal — exported for core/testing.
 */
export async function dispatchNamespaced(
  argv: string[],
  options: NamespacedCliOptions
): Promise<RunOutcome> {
  const { args, outputMode, envError, envName, globals } = resolveGlobalFlags(argv);
  const startedAt = globals.startedAt;

  vlog("belz start", {
    argv: args,
    env: envName ?? Config.activeEnv.name,
    mode: outputMode,
  });

  if (envError) {
    return globalErrorOutcome(options.binaryName, outputMode, envError, startedAt);
  }

  const printHelp = () => {
    console.log();
    console.log(wordmark);
    console.log();
    console.log(`${theme.heading("usage")}  ${theme.accent(options.binaryName)} <module|command> [args]`);
    console.log();
    console.log(theme.heading("modules"));
    for (const [mod, def] of Object.entries(options.namespaces)) {
      console.log(`  ${theme.accent(mod.padEnd(9))} ${theme.faint(def.description)}`);
    }
    if (Object.keys(options.topLevel).length > 0) {
      console.log();
      console.log(theme.heading("commands"));
      Object.keys(options.topLevel).forEach(cmd => console.log(`  ${theme.accent(cmd)}`));
    }
    console.log();
    console.log(theme.heading("flags"));
    console.log(`  ${theme.accent("-v, --verbose")}   ${theme.faint("stream timestamped debug logs to stderr")}`);
    console.log(`  ${theme.accent("--llm")}           ${theme.faint("structured JSON output (the default inside an agent session)")}`);
    console.log(`  ${theme.accent("--human")}         ${theme.faint("readable output, also inside an agent session")}`);
    console.log(`  ${theme.accent("-e, --env <n>")}   ${theme.faint("run against a specific environment (required for writes)")}`);
    if (options.build) console.log(`  ${theme.accent("--version")}       ${theme.faint("print the version and build SHA")}`);
    if (options.helpFull) console.log(`  ${theme.accent("--help-full")}     ${theme.faint("every command variant; [<module>] for one module, [--index] one line per command")}`);
    console.log();
    console.log(theme.faint(`${symbols.arrow} ${options.binaryName} <module> --help  for module commands`));
  };

  const token = args[0];

  if (token === "--version" && options.build) {
    const build = options.build;
    if (outputMode === "llm") {
      return envelopeOutcome(
        outputMode,
        runnerEnvelope(options.binaryName, "version", "version", startedAt, {
          ok: true,
          data: { name: options.binaryName, ...build },
        }),
        0
      );
    }
    return printOutcome(0, () => console.log(formatBuildInfo(options.binaryName, build)));
  }

  if (token === "--help-full" && options.helpFull) {
    // `--help-full [<namespace>] [--index]` (the full text is ~35 KB).
    const rest = args.slice(1);
    const bad = rest.filter((a) => a.startsWith("-") && a !== "--index");
    const words = rest.filter((a) => !a.startsWith("-"));
    const namespace = words[0];
    const text =
      bad.length > 0 || words.length > 1 ? null : options.helpFull({ ...(namespace ? { namespace } : {}), index: rest.includes("--index") });
    if (text === null) {
      const message =
        bad.length > 0 || words.length > 1
          ? `Usage: ${options.binaryName} --help-full [<namespace>] [--index] (got: ${rest.join(" ")})`
          : `Unknown namespace '${namespace}' for --help-full. Namespaces: ${[...Object.keys(options.namespaces), "top"].join(", ")}`;
      if (outputMode === "llm") {
        return envelopeOutcome(
          outputMode,
          runnerEnvelope(options.binaryName, "help", "help-full", startedAt, { ok: false, error: { code: "INVALID_ARGS", message } }),
          1
        );
      }
      return printOutcome(1, () => printErr(theme.err(message)));
    }
    if (outputMode === "llm") {
      return envelopeOutcome(
        outputMode,
        runnerEnvelope(options.binaryName, "help", "help-full", startedAt, { ok: true, data: { text } }),
        0
      );
    }
    return printOutcome(0, () => console.log(text));
  }

  if (!token || token === "--help" || token === "-h") {
    if (outputMode === "llm") {
      return envelopeOutcome(
        outputMode,
        runnerEnvelope(options.binaryName, "help", "help", startedAt, {
          ok: true,
          data: {
            name: options.name,
            description: options.description,
            binaryName: options.binaryName,
            ...(options.build ? { version: options.build.version, sha: options.build.sha } : {}),
            modules: Object.fromEntries(
              Object.entries(options.namespaces).map(([k, v]) => [k, {
                name: v.name,
                description: v.description,
                commands: v.commands ? Object.keys(v.commands) : [],
              }])
            ),
            commands: Object.keys(options.topLevel),
          },
        }),
        0
      );
    }
    return printOutcome(0, printHelp);
  }

  // Module dispatch
  const ns = Object.hasOwn(options.namespaces, token) ? options.namespaces[token] : undefined;
  if (ns) {
    const helpResolver = ns.helpResolver
      ?? (ns.helpDir
        ? async (cmd: string) => {
            const p = `${ns.helpDir}/${cmd}/help.txt`;
            try {
              const file = Bun.file(p);
              if (await file.exists()) return await file.text();
            } catch { /* ignore */ }
            return null;
          }
        : undefined);

    // Passthrough module: single CommandModule that handles its own sub-routing.
    // Pass full args (including the module token) so the command name resolves correctly.
    if (ns.command) {
      return dispatchCommand(args, { [token]: ns.command }, outputMode, options.binaryName, helpResolver, {
        globals, base: 0, envAware: ns.envAware,
      });
    }

    // Multi-command module (ad, pd style)
    const remainingArgs = args.slice(1);
    const modBinaryName = `${options.binaryName} ${token}`;

    if (!remainingArgs[0] || remainingArgs[0] === "--help" || remainingArgs[0] === "-h") {
      if (outputMode === "llm") {
        return envelopeOutcome(
          outputMode,
          runnerEnvelope(options.binaryName, "help", token, startedAt, {
            ok: true,
            data: {
              name: ns.name,
              description: ns.description,
              binaryName: modBinaryName,
              commands: Object.keys(ns.commands!),
            },
          }),
          0
        );
      }
      return printOutcome(0, () => {
        console.log();
        console.log(`${theme.heading(ns.name)}  ${theme.faint(symbols.dot)}  ${theme.faint(ns.description)}`);
        console.log();
        console.log(`${theme.heading("usage")}  ${theme.accent(modBinaryName)} <command> [args]`);
        console.log();
        console.log(theme.heading("commands"));
        Object.keys(ns.commands!).forEach(cmd => console.log(`  ${theme.accent(cmd)}`));
        console.log();
        console.log(theme.faint(`${symbols.arrow} ${modBinaryName} <command> --help  for details`));
      });
    }

    const outcome = await dispatchCommand(remainingArgs, ns.commands!, outputMode, modBinaryName, helpResolver, {
      globals, base: 1, envAware: ns.envAware,
    });
    // Runner-level envelopes are named after the root binary, not the module.
    return outcome;
  }

  // Top-level command dispatch
  if (Object.hasOwn(options.topLevel, token)) {
    const helpResolver = options.topLevelHelpResolver
      ?? (options.topLevelHelpDir
        ? async (cmd: string) => {
            const p = `${options.topLevelHelpDir}/${cmd}/help.txt`;
            try {
              const file = Bun.file(p);
              if (await file.exists()) return await file.text();
            } catch { /* ignore */ }
            return null;
          }
        : undefined);

    return dispatchCommand(args, options.topLevel, outputMode, options.binaryName, helpResolver, {
      globals, base: 0, envAware: options.topLevelEnvAware?.[token],
    });
  }

  // Unknown
  if (outputMode === "llm") {
    return envelopeOutcome(
      outputMode,
      runnerEnvelope(options.binaryName, "runner", token, startedAt, {
        ok: false,
        error: { code: "UNKNOWN_COMMAND", message: `Unknown module or command: ${token}` },
      }),
      1
    );
  }
  return unknownPrintOutcome(() => {
    printErr(theme.err(`Unknown module or command: ${theme.bold(token)}`));
    printHelp();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toEnvelope(
  schema: string,
  commandName: string,
  result: CommandResult,
  startedAt: number,
  envName: string | null,
  warnings: string[],
  envSource: MetaEnvSource | null = null
): CommandEnvelope {
  const meta: Record<string, unknown> = { ...(result.meta ?? {}) };
  delete meta.env;
  delete meta.envSource;
  if (envName !== null) meta.env = envName;
  if (envName !== null && envSource !== null) meta.envSource = envSource;
  meta.durationMs = Date.now() - startedAt;
  const allWarnings = [
    ...(Array.isArray(meta.warnings) ? (meta.warnings as unknown[]).map(String) : []),
    ...warnings,
  ];
  if (allWarnings.length > 0) meta.warnings = allWarnings;
  else delete meta.warnings;

  return {
    schema,
    version: ENVELOPE_VERSION,
    ok: result.ok,
    command: commandName,
    data: result.ok ? result.data : (result.data ?? null),
    error: result.ok ? null : normalizeCommandError(result.error),
    meta,
  };
}

/** `"Error: x"` → `"x"` (messages never carry the prefix; human rendering adds its own marker). */
function stripErrorPrefix(message: string): string {
  return message.replace(/^\s*(?:[A-Za-z]*Error:\s*)+/, "");
}

/**
 * `error.details` on the wire is always an object: a JSON-object string is
 * parsed, any other string becomes `{ text }`, arrays `{ items }`, scalars `{ value }`.
 */
export function normalizeDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined || details === null) return undefined;
  if (details instanceof Error) {
    return { message: details.message, ...(verboseEnabled() && details.stack ? { stack: details.stack } : {}) };
  }
  if (typeof details === "string") {
    const trimmed = details.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch { /* not JSON */ }
    }
    return { text: details };
  }
  if (Array.isArray(details)) return { items: details };
  if (typeof details === "object") return details as Record<string, unknown>;
  return { value: details };
}

function normalizeCommandError(error: CommandError): CommandError {
  const details = normalizeDetails(error.details);
  return {
    code: error.code || "CLI_ERROR",
    message: stripErrorPrefix(String(error.message ?? "")),
    ...(details !== undefined ? { details } : {}),
  };
}

function normalizeError(error: unknown): CommandError {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return {
      code: "UNHANDLED_EXCEPTION",
      message: error.message,
      details: verboseEnabled() && error.stack ? { stack: error.stack } : undefined,
    };
  }
  return {
    code: "UNHANDLED_EXCEPTION",
    message: String(error),
  };
}
