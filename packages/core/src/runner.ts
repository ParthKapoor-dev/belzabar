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

export async function runCli(
  argv: string[],
  commandMap: Record<string, any>,
  options: CliOptions,
  helpResolver?: (cmd: string) => Promise<string | null>
) {
  let args = argv.slice(2);
  const startedAt = Date.now();
  let outputMode: "human" | "llm" = "human";
  const warnings: string[] = [];

  const llmIndex = args.indexOf("--llm");
  if (llmIndex !== -1) {
    outputMode = "llm";
    args.splice(llmIndex, 1);
  }

  const envIndex = args.findIndex(a => a === "--env" || a === "-e");
  if (envIndex !== -1) {
    if (envIndex + 1 >= args.length) {
      return exitWithEnvelope(
        outputMode,
        {
          schema: `${options.binaryName}.runner`,
          version: "2.0",
          ok: false,
          command: "global",
          data: null,
          error: { code: "MISSING_ENV_ARG", message: "Error: --env flag requires an argument." },
          meta: {},
        },
        1
      );
    }
    const envName = args[envIndex + 1] as string;
    try {
      Config.setActiveEnv(envName);
    } catch (e: any) {
      return exitWithEnvelope(
        outputMode,
        {
          schema: `${options.binaryName}.runner`,
          version: "2.0",
          ok: false,
          command: "global",
          data: null,
          error: { code: "INVALID_ENV", message: `Error: ${e.message}` },
          meta: {},
        },
        1
      );
    }
    args.splice(envIndex, 2);
  }

  const activeEnv = Config.activeEnv;
  const commandName = args[0];

  const listCommandsHuman = () => {
    console.log(options.name);
    console.log(options.description);
    console.log(`Usage: ${options.binaryName} <command> [args]\n`);
    console.log("Available Commands:");
    Object.keys(commandMap).forEach(cmd => console.log(`  - ${cmd}`));
    console.log(`\nRun '${options.binaryName} <command> --help' for details.`);
  };

  if (!commandName || commandName === "--help" || commandName === "-h") {
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
          schema: `${options.binaryName}.runner`,
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
          schema: `${options.binaryName}.help`,
          version: "2.0",
          ok: true,
          command: commandName,
          data: {
            help: helpText ?? `No help file found for '${commandName}'.`,
          },
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
    binaryName: options.binaryName,
    commandName,
    warn: (message: string) => {
      warnings.push(message);
    },
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
    const failureResult: CommandResult = {
      ok: false,
      error: normalizedError,
    };
    const envelope = toEnvelope(commandName, command, failureResult, startedAt, activeEnv.name, warnings);
    exitWithEnvelope(outputMode, envelope, 1, command.presentHuman);
  }
}

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
