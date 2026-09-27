import { Config } from "./config";
import {
  CliError,
  type CommandContext,
  type CommandEnvelope,
  type CommandError,
  type CommandModule,
  type CommandResult,
  type HumanPresenterHelpers,
} from "./command";
import { printErr, renderHuman, renderLLM, setOutputMode } from "./ui";
import { ui as theme, symbols, wordmark } from "./theme";
import { verboseEnabled, vlog } from "./verbose";
import { ENVELOPE_VERSION } from "./envelope";
import { declaresFlag, type AnyArgsDef } from "./args";

export interface NamespaceDefinition {
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
export interface BuildInfo {
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
export async function flushStdio(): Promise<void> {
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
export interface VerboseToken {
  /** Index in `GlobalFlags.args` the token stood before (== args.length when trailing). */
  index: number;
  token: string;
}

export interface GlobalFlags {
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
 * Pure parser for the global flags `--llm`, `-v/--verbose`, `-e/--env <name>`, `--env=<name>`, `-e=<name>`.
 * Parsing stops at `--`: everything after it (including a literal `--llm` or
 * `-v`) is left for the command. A missing value, or `--env` given more than
 * once, is an error.
 */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const args: string[] = [];
  const verboseTokens: VerboseToken[] = [];
  let outputMode: "human" | "llm" = "human";
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
    if (a === "--llm") { outputMode = "llm"; continue; }
    if (VERBOSE_TOKENS.has(a)) { verboseTokens.push({ index: args.length, token: a }); continue; }
    if (a === "--env" || a === "-e") {
      const next = argv[i + 1];
      if (next === undefined || next === "--" || next.startsWith("-")) {
        setError("MISSING_ENV_ARG", "--env requires an environment name (e.g. --env nsm-dev).");
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
        setError("MISSING_ENV_ARG", "--env requires an environment name (e.g. --env nsm-dev).");
        continue;
      }
      setEnv(value, "--env");
      continue;
    }
    args.push(a);
  }

  return { args, outputMode, verbose: verboseTokens.length > 0, verboseTokens, envName, error };
}

/** Process-wide global state for one invocation, threaded into dispatch. */
export interface GlobalContext {
  /** `--env` was given explicitly. */
  envExplicit: boolean;
  verboseTokens: VerboseToken[];
  /** BELZ_VERBOSE as it was before the global flags were applied. */
  verboseEnvBefore: string | undefined;
  /** The default env (BELZ_ENV / config.json `defaultEnv`) is not configured. */
  defaultEnvError: { code: string; message: string } | null;
  startedAt: number;
}

/**
 * Select the default env for a run without `--env` (D6): BELZ_ENV > config.json
 * `defaultEnv` > nsm-dev (core/config owns the precedence). Returns an error
 * when the default names an env that is not configured.
 */
function applyDefaultEnv(): { code: string; message: string } | null {
  const cfg = Config as typeof Config & { resetActiveEnv?: () => void; envSource?: string };
  let source = "default";
  if (typeof cfg.resetActiveEnv === "function") {
    cfg.resetActiveEnv();
    source = cfg.envSource === "BELZ_ENV" ? "BELZ_ENV" : cfg.envSource === "config" ? "config.json defaultEnv" : "default";
  } else {
    // Pre-D6 config module: honour BELZ_ENV here.
    const fromEnv = process.env.BELZ_ENV?.trim();
    if (fromEnv && Config.getAllEnvs()[fromEnv]) Config.setActiveEnv(fromEnv);
    else if (fromEnv) return unknownDefault(fromEnv, "BELZ_ENV");
  }
  const name = Config.activeEnv.name;
  return Config.getAllEnvs()[name] ? null : unknownDefault(name, source);
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
  const parsed = parseGlobalFlags(argv);
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
  | { kind: "print"; exitCode: number; print: () => void };

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

/** Write an outcome to stdout/stderr (no exit). Human errors and warnings go to stderr. */
export function renderOutcome(outcome: RunOutcome): void {
  if (outcome.kind === "print") {
    outcome.print();
    return;
  }
  const { outputMode, envelope, presenter } = outcome;
  if (outputMode === "llm") {
    renderLLM(envelope);
  } else {
    renderHuman(envelope, presenter);
  }
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

// ── Command-owned global flags (CORE-7) ─────────────────────────────────────

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

export interface DispatchOptions {
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
    return printOutcome(1, () => {
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

  // -v/--verbose after the command name belongs to the command when it declares it (CORE-7).
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
  const activeEnv = Config.activeEnv;
  const envExplicit = globals?.envExplicit ?? false;
  const envForMeta = envAware ? activeEnv.name : null;
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
    const writes =
      envAware && (typeof command.writes === "function" ? command.writes(parsedArgs) : command.writes === true);
    if (writes && !envExplicit) {
      throw new CliError(
        `'${binaryName} ${commandName}' writes to an environment, so --env is required ` +
          `(the default env is '${activeEnv.name}'; to target it, add --env ${activeEnv.name}).`,
        { code: "ENV_REQUIRED_FOR_WRITE", details: { defaultEnv: activeEnv.name } }
      );
    }
    if (writes && outputMode === "human") {
      printErr(theme.faint(`${symbols.arrow} target env: ${activeEnv.name} (${activeEnv.baseUrl})`));
    }

    const result = await command.execute(parsedArgs, commandContext);
    const envelope = toEnvelope(schema, commandName, result, startedAt, envForMeta, warnings);
    return envelopeOutcome(outputMode, envelope, envelope.ok ? 0 : 1, command.presentHuman);
  } catch (error: unknown) {
    const normalizedError = normalizeError(error);
    const failureResult: CommandResult = { ok: false, error: normalizedError };
    const envelope = toEnvelope(schema, commandName, failureResult, startedAt, envForMeta, warnings);
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
  await finishOutcome(await dispatchNamespaced(argv.slice(2), options));
}

/** `belz 0.1.0 (abc1234)` */
export function formatBuildInfo(binaryName: string, build: BuildInfo): string {
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
    console.log(`  ${theme.accent("--llm")}           ${theme.faint("structured machine-readable output")}`);
    console.log(`  ${theme.accent("-e, --env <n>")}   ${theme.faint("run against a specific environment (required for writes)")}`);
    if (options.build) console.log(`  ${theme.accent("--version")}       ${theme.faint("print the version and build SHA")}`);
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
  return printOutcome(1, () => {
    printErr(theme.err(`Unknown module or command: ${theme.bold(token)}`));
    printHelp();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function toEnvelope(
  schema: string,
  commandName: string,
  result: CommandResult,
  startedAt: number,
  envName: string | null,
  warnings: string[]
): CommandEnvelope {
  const meta: Record<string, unknown> = { ...(result.meta ?? {}) };
  delete meta.env;
  if (envName !== null) meta.env = envName;
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
export function stripErrorPrefix(message: string): string {
  return message.replace(/^\s*(?:[A-Za-z]*Error:\s*)+/, "");
}

/**
 * `error.details` on the wire is always an object (F38): a JSON-object string is
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
