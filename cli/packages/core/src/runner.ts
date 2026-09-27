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
import { renderHuman, renderLLM, setOutputMode } from "./ui";
import { ui as theme, symbols, wordmark } from "./theme";
import { vlog } from "./verbose";

export interface CliOptions {
  name: string;
  description: string;
  binaryName: string;
}

export interface NamespaceDefinition {
  name: string;
  description: string;
  /** Sub-command map (ad, pd style). Mutually exclusive with `command`. */
  commands?: Record<string, any>;
  /** Passthrough: a single CommandModule that handles its own sub-routing (migrate style). */
  command?: any;
  helpDir?: string;
  helpResolver?: (cmd: string) => Promise<string | null>;
}

export interface NamespacedCliOptions {
  name: string;
  description: string;
  binaryName: string;
  namespaces: Record<string, NamespaceDefinition>;
  topLevel: Record<string, any>;
  topLevelHelpDir?: string;
  topLevelHelpResolver?: (cmd: string) => Promise<string | null>;
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

export interface GlobalFlags {
  /** argv with the global flags removed (everything from `--` onward is kept verbatim). */
  args: string[];
  outputMode: "human" | "llm";
  verbose: boolean;
  envName: string | null;
  error: { code: string; message: string } | null;
}

/**
 * Pure parser for the global flags `--llm`, `-v/--verbose`, `-e/--env <name>`, `--env=<name>`, `-e=<name>`.
 * Parsing stops at `--`. A missing value, or `--env` given more than once, is an error.
 */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const args: string[] = [];
  let outputMode: "human" | "llm" = "human";
  let verbose = false;
  let envName: string | null = null;
  let error: GlobalFlags["error"] = null;
  const setError = (code: string, message: string) => { if (!error) error = { code, message }; };
  const setEnv = (value: string, flag: string) => {
    if (envName !== null) {
      setError(
        "INVALID_ARGS",
        value === envName
          ? `Error: ${flag} given more than once.`
          : `Error: conflicting --env values '${envName}' and '${value}'.`
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
    if (a === "-v" || a === "--verbose") { verbose = true; continue; }
    if (a === "--env" || a === "-e") {
      const next = argv[i + 1];
      if (next === undefined || next === "--" || next.startsWith("-")) {
        setError("MISSING_ENV_ARG", "Error: --env flag requires an argument.");
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
        setError("MISSING_ENV_ARG", "Error: --env flag requires an argument.");
        continue;
      }
      setEnv(value, "--env");
      continue;
    }
    args.push(a);
  }

  return { args, outputMode, verbose, envName, error };
}

function stripGlobalFlags(argv: string[]): {
  args: string[];
  outputMode: "human" | "llm";
  envName: string | null;
  envError: { code: string; message: string } | null;
} {
  installStdioGuard();
  const parsed = parseGlobalFlags(argv);
  if (parsed.verbose) process.env.BELZ_VERBOSE = "1";
  setOutputMode(parsed.outputMode);

  let envError = parsed.error;
  if (!envError && parsed.envName !== null) {
    try {
      Config.setActiveEnv(parsed.envName);
    } catch (e: any) {
      envError = { code: "INVALID_ENV", message: `Error: ${e.message}` };
    }
  }

  return { args: parsed.args, outputMode: parsed.outputMode, envName: parsed.envName, envError };
}

/** True when `-h`/`--help` appears anywhere before a `--` terminator. */
export function hasHelpFlag(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === "--help" || a === "-h") return true;
  }
  return false;
}

async function dispatchCommand(
  args: string[],
  commandMap: Record<string, any>,
  outputMode: "human" | "llm",
  binaryName: string,
  helpResolver?: (cmd: string) => Promise<string | null>
): Promise<void> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const activeEnv = Config.activeEnv;
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
      return exitWithEnvelope(
        outputMode,
        {
          schema: `${binaryName}.help`,
          version: "2.0",
          ok: true,
          command: "help",
          data: { binaryName, commands: Object.keys(commandMap) },
          error: null,
          meta: {},
        },
        0
      );
    }
    listCommandsHuman();
    return flushAndExit(0);
  }

  const commandModule = commandMap[commandName];
  const command = (commandModule?.default ?? commandModule) as CommandModule<any, any>;

  if (!command) {
    if (outputMode === "llm") {
      return exitWithEnvelope(
        outputMode,
        {
          schema: `${binaryName}.runner`,
          version: "2.0",
          ok: false,
          command: commandName,
          data: null,
          error: { code: "UNKNOWN_COMMAND", message: `Unknown command: ${commandName}` },
          meta: {},
        },
        1
      );
    }
    console.error(theme.err(`Unknown command: ${theme.bold(commandName)}`));
    listCommandsHuman();
    return flushAndExit(1);
  }

  if (hasHelpFlag(args.slice(1))) {
    let helpText: string | null = null;
    if (helpResolver) {
      helpText = await helpResolver(commandName);
    }
    if (outputMode === "llm") {
      return exitWithEnvelope(
        outputMode,
        {
          schema: `${binaryName}.help`,
          version: "2.0",
          ok: true,
          command: commandName,
          data: { help: helpText ?? `No help file found for '${commandName}'.` },
          error: null,
          meta: {},
        },
        0
      );
    }
    console.log(helpText ?? `No help file found for '${commandName}'.`);
    return flushAndExit(0);
  }

  const commandContext: CommandContext = {
    outputMode,
    env: activeEnv,
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

    const parsedArgs = command.parseArgs
      ? await command.parseArgs(args.slice(1), commandContext)
      : args.slice(1);
    const result = await command.execute(parsedArgs, commandContext);
    const envelope = toEnvelope(commandName, command, result, startedAt, activeEnv.name, warnings);
    return exitWithEnvelope(outputMode, envelope, envelope.ok ? 0 : 1, command.presentHuman);
  } catch (error: unknown) {
    const normalizedError = normalizeError(error);
    const failureResult: CommandResult = { ok: false, error: normalizedError };
    const envelope = toEnvelope(commandName, command, failureResult, startedAt, activeEnv.name, warnings);
    return exitWithEnvelope(outputMode, envelope, 1, command.presentHuman);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function runCli(
  argv: string[],
  commandMap: Record<string, any>,
  options: CliOptions,
  helpResolver?: (cmd: string) => Promise<string | null>
) {
  const { args, outputMode, envError } = stripGlobalFlags(argv.slice(2));

  if (envError) {
    return exitWithEnvelope(
      outputMode,
      {
        schema: `${options.binaryName}.runner`,
        version: "2.0",
        ok: false,
        command: "global",
        data: null,
        error: envError,
        meta: {},
      },
      1
    );
  }

  if (!args[0] || args[0] === "--help" || args[0] === "-h") {
    if (outputMode === "llm") {
      return exitWithEnvelope(
        outputMode,
        {
          schema: `${options.binaryName}.help`,
          version: "2.0",
          ok: true,
          command: "help",
          data: {
            name: options.name,
            description: options.description,
            binaryName: options.binaryName,
            commands: Object.keys(commandMap),
          },
          error: null,
          meta: {},
        },
        0
      );
    }
    console.log();
    console.log(wordmark);
    await dispatchCommand([], commandMap, outputMode, options.binaryName, helpResolver);
    return;
  }

  return dispatchCommand(args, commandMap, outputMode, options.binaryName, helpResolver);
}

export async function runNamespacedCli(
  argv: string[],
  options: NamespacedCliOptions
): Promise<void> {
  const { args, outputMode, envError, envName } = stripGlobalFlags(argv.slice(2));

  vlog("belz start", {
    argv: args,
    env: envName ?? Config.activeEnv.name,
    mode: outputMode,
  });

  if (envError) {
    return exitWithEnvelope(
      outputMode,
      {
        schema: `${options.binaryName}.runner`,
        version: "2.0",
        ok: false,
        command: "global",
        data: null,
        error: envError,
        meta: {},
      },
      1
    );
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
    console.log(`  ${theme.accent("-e, --env <n>")}   ${theme.faint("run against a specific environment")}`);
    console.log();
    console.log(theme.faint(`${symbols.arrow} ${options.binaryName} <module> --help  for module commands`));
  };

  const token = args[0];

  if (!token || token === "--help" || token === "-h") {
    if (outputMode === "llm") {
      return exitWithEnvelope(
        outputMode,
        {
          schema: `${options.binaryName}.help`,
          version: "2.0",
          ok: true,
          command: "help",
          data: {
            name: options.name,
            description: options.description,
            binaryName: options.binaryName,
            modules: Object.fromEntries(
              Object.entries(options.namespaces).map(([k, v]) => [k, {
                name: v.name,
                description: v.description,
                commands: v.commands ? Object.keys(v.commands) : [],
              }])
            ),
            commands: Object.keys(options.topLevel),
          },
          error: null,
          meta: {},
        },
        0
      );
    }
    printHelp();
    return flushAndExit(0);
  }

  // Module dispatch
  const ns = options.namespaces[token];
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
      return dispatchCommand(args, { [token]: ns.command }, outputMode, options.binaryName, helpResolver);
    }

    // Multi-command module (ad, pd style)
    const remainingArgs = args.slice(1);
    const modBinaryName = `${options.binaryName} ${token}`;

    if (!remainingArgs[0] || remainingArgs[0] === "--help" || remainingArgs[0] === "-h") {
      if (outputMode === "llm") {
        return exitWithEnvelope(
          outputMode,
          {
            schema: `${modBinaryName}.help`,
            version: "2.0",
            ok: true,
            command: "help",
            data: {
              name: ns.name,
              description: ns.description,
              binaryName: modBinaryName,
              commands: Object.keys(ns.commands!),
            },
            error: null,
            meta: {},
          },
          0
        );
      }
      console.log();
      console.log(`${theme.heading(ns.name)}  ${theme.faint(symbols.dot)}  ${theme.faint(ns.description)}`);
      console.log();
      console.log(`${theme.heading("usage")}  ${theme.accent(modBinaryName)} <command> [args]`);
      console.log();
      console.log(theme.heading("commands"));
      Object.keys(ns.commands!).forEach(cmd => console.log(`  ${theme.accent(cmd)}`));
      console.log();
      console.log(theme.faint(`${symbols.arrow} ${modBinaryName} <command> --help  for details`));
      return flushAndExit(0);
    }

    return dispatchCommand(remainingArgs, ns.commands!, outputMode, modBinaryName, helpResolver);
  }

  // Top-level command dispatch
  if (options.topLevel[token]) {
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

    return dispatchCommand(args, options.topLevel, outputMode, options.binaryName, helpResolver);
  }

  // Unknown
  if (outputMode === "llm") {
    return exitWithEnvelope(
      outputMode,
      {
        schema: `${options.binaryName}.runner`,
        version: "2.0",
        ok: false,
        command: token,
        data: null,
        error: { code: "UNKNOWN_COMMAND", message: `Unknown module or command: ${token}` },
        meta: {},
      },
      1
    );
  }
  console.error(theme.err(`Unknown module or command: ${theme.bold(token)}`));
  printHelp();
  return flushAndExit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toEnvelope(
  commandName: string,
  command: CommandModule<any, any>,
  result: CommandResult,
  startedAt: number,
  envName: string,
  warnings: string[]
): CommandEnvelope {
  const baseMeta = {
    ...(result.meta ?? {}),
    env: envName,
    durationMs: Date.now() - startedAt,
  };
  if (warnings.length > 0) {
    (baseMeta as any).warnings = warnings;
  }

  return {
    schema: command.schema ?? `${commandName}.result`,
    version: command.version ?? "2.0",
    ok: result.ok,
    command: commandName,
    data: result.ok ? result.data : (result.data ?? null),
    error: result.ok ? null : result.error,
    meta: baseMeta,
  };
}

function normalizeError(error: unknown): CommandError {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return {
      code: "UNHANDLED_EXCEPTION",
      message: error.message,
      details: process.env.VERBOSE ? error.stack : undefined,
    };
  }
  return {
    code: "UNHANDLED_EXCEPTION",
    message: String(error),
  };
}

async function exitWithEnvelope(
  outputMode: "human" | "llm",
  envelope: CommandEnvelope,
  exitCode: number,
  presenter?: (envelope: CommandEnvelope<unknown>, ui: HumanPresenterHelpers) => void
) {
  if (outputMode === "llm") {
    renderLLM(envelope);
  } else {
    renderHuman(envelope, envelope.ok ? presenter : undefined);
  }
  await flushAndExit(exitCode);
}
