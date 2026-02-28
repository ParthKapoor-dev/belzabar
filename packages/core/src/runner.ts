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
import { renderHuman, renderLLM } from "./output";

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

function stripGlobalFlags(argv: string[]): {
  args: string[];
  outputMode: "human" | "llm";
  envName: string | null;
  envError: string | null;
} {
  let args = [...argv];
  let outputMode: "human" | "llm" = "human";
  let envName: string | null = null;
  let envError: string | null = null;

  const llmIndex = args.indexOf("--llm");
  if (llmIndex !== -1) {
    outputMode = "llm";
    args.splice(llmIndex, 1);
  }

  const envIndex = args.findIndex(a => a === "--env" || a === "-e");
  if (envIndex !== -1) {
    if (envIndex + 1 >= args.length) {
      envError = "Error: --env flag requires an argument.";
    } else {
      envName = args[envIndex + 1] as string;
      try {
        Config.setActiveEnv(envName);
      } catch (e: any) {
        envError = `Error: ${e.message}`;
      }
      args.splice(envIndex, 2);
    }
  }

  return { args, outputMode, envName, envError };
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
    console.log(`Usage: ${binaryName} <command> [args]\n`);
    console.log("Available Commands:");
    Object.keys(commandMap).forEach(cmd => console.log(`  - ${cmd}`));
    console.log(`\nRun '${binaryName} <command> --help' for details.`);
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
    process.exit(0);
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
    console.error(`❌ Unknown command: ${commandName}`);
    listCommandsHuman();
    process.exit(1);
  }

  if (args[1] === "--help" || args[1] === "-h") {
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
    process.exit(0);
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
    exitWithEnvelope(outputMode, envelope, envelope.ok ? 0 : 1, command.presentHuman);
  } catch (error: unknown) {
    const normalizedError = normalizeError(error);
    const failureResult: CommandResult = { ok: false, error: normalizedError };
    const envelope = toEnvelope(commandName, command, failureResult, startedAt, activeEnv.name, warnings);
    exitWithEnvelope(outputMode, envelope, 1, command.presentHuman);
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
        error: { code: envError.includes("requires") ? "MISSING_ENV_ARG" : "INVALID_ENV", message: envError },
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
    console.log(options.name);
    console.log(options.description);
    await dispatchCommand([], commandMap, outputMode, options.binaryName, helpResolver);
    return;
  }

  return dispatchCommand(args, commandMap, outputMode, options.binaryName, helpResolver);
}

export async function runNamespacedCli(
  argv: string[],
  options: NamespacedCliOptions
): Promise<void> {
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
        error: {
          code: envError.includes("requires") ? "MISSING_ENV_ARG" : "INVALID_ENV",
          message: envError,
        },
        meta: {},
      },
      1
    );
  }

  const printHelp = () => {
    console.log(options.name);
    console.log(options.description);
    console.log(`\nUsage: ${options.binaryName} <module|command> [args]\n`);
    console.log("Modules:");
    for (const [mod, def] of Object.entries(options.namespaces)) {
      console.log(`  ${mod.padEnd(8)}  ${def.description}`);
    }
    if (Object.keys(options.topLevel).length > 0) {
      console.log("\nCommands:");
      Object.keys(options.topLevel).forEach(cmd => console.log(`  - ${cmd}`));
    }
    console.log(`\nRun '${options.binaryName} <module> --help' for module commands.`);
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
    process.exit(0);
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
      console.log(`${ns.name} — ${ns.description}`);
      console.log(`\nUsage: ${modBinaryName} <command> [args]\n`);
      console.log("Commands:");
      Object.keys(ns.commands!).forEach(cmd => console.log(`  - ${cmd}`));
      console.log(`\nRun '${modBinaryName} <command> --help' for details.`);
      process.exit(0);
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
  console.error(`❌ Unknown module or command: ${token}`);
  printHelp();
  process.exit(1);
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

function exitWithEnvelope(
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
  process.exit(exitCode);
}
