// runCommand / runCliInProcess: drive a CommandModule (or the whole namespaced
// CLI) through the real runner dispatch, in-process, capturing output.
//
//   const r = await runCommand(showCommand, ["abc123"], { env: "t-dev" });
//   r.envelope?.ok; r.exitCode; r.stdout; r.stderr;
//
// Global flags (--llm, --env, -v) go through the same parser as the binary.
// `llm` defaults to true. process.exit is trapped for the duration of the run
// (a command calling it gets an error envelope instead of killing the test).

import { Config } from "../config";
import type { CommandEnvelope, CommandModule } from "../command";
import { getOutputMode, setOutputMode } from "../ui";
import {
  dispatchCommand,
  dispatchNamespaced,
  globalErrorOutcome,
  renderOutcome,
  resolveGlobalFlags,
  type NamespacedCliOptions,
  type RunOutcome,
} from "../runner";

interface RunOptions {
  /** Environment name, passed as `--env <name>`. */
  env?: string;
  /** `--llm` output (default true). */
  llm?: boolean;
}

interface RunCommandOptions extends RunOptions {
  /** Name the command is registered under (default "cmd"). */
  commandName?: string;
  binaryName?: string;
  helpResolver?: (cmd: string) => Promise<string | null>;
}

export interface RunResult {
  /** The envelope as it goes over the wire (JSON round-tripped); null for human-only output. */
  envelope: CommandEnvelope | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  outcome: RunOutcome;
}

class ProcessExitTrap extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code}) called in-process`);
    this.name = "ProcessExitTrap";
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialize runs: they share process-wide state (console, active env, output mode). */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Global flags go first, so a `--` in argv keeps everything after it verbatim. */
function withGlobalArgs(argv: string[], opts: RunOptions): string[] {
  const globals: string[] = [];
  if (opts.llm !== false) globals.push("--llm");
  if (opts.env) globals.push("--env", opts.env);
  return [...globals, ...argv];
}

async function captured(run: () => Promise<RunOutcome>): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const { format } = require("node:util") as typeof import("node:util");

  const saved = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
    exit: process.exit,
    outputMode: getOutputMode(),
    env: Config.activeEnv.name,
    verbose: process.env.WI_IMPL_VERBOSE,
  };

  const toOut = (...a: unknown[]) => { out.push(format(...a) + "\n"); };
  const toErr = (...a: unknown[]) => { err.push(format(...a) + "\n"); };
  const writer = (sink: string[]) =>
    ((chunk: any, enc?: any, cb?: any) => {
      sink.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      const done = typeof enc === "function" ? enc : cb;
      if (typeof done === "function") done();
      return true;
    }) as typeof process.stdout.write;

  console.log = toOut;
  console.info = toOut;
  console.debug = toOut;
  console.warn = toErr;
  console.error = toErr;
  process.stdout.write = writer(out);
  process.stderr.write = writer(err);
  process.exit = ((code?: number) => { throw new ProcessExitTrap(code ?? 0); }) as typeof process.exit;

  let outcome: RunOutcome;
  try {
    outcome = await run();
    renderOutcome(outcome);
  } finally {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
    console.warn = saved.warn;
    console.error = saved.error;
    process.stdout.write = saved.stdoutWrite;
    process.stderr.write = saved.stderrWrite;
    process.exit = saved.exit;
    setOutputMode(saved.outputMode);
    try { Config.setActiveEnv(saved.env); } catch { /* env table reloaded */ }
    if (saved.verbose === undefined) delete process.env.WI_IMPL_VERBOSE;
    else process.env.WI_IMPL_VERBOSE = saved.verbose;
  }

  const envelope =
    outcome.kind === "envelope" ? (JSON.parse(JSON.stringify(outcome.envelope)) as CommandEnvelope) : null;
  return { envelope, stdout: out.join(""), stderr: err.join(""), exitCode: outcome.exitCode, outcome };
}

/** Run one CommandModule through the runner's dispatch (global flags, --help, parseArgs, execute, envelope). */
export function runCommand(
  module: CommandModule<any, any> | { default: CommandModule<any, any> },
  argv: string[] = [],
  opts: RunCommandOptions = {}
): Promise<RunResult> {
  const name = opts.commandName ?? "cmd";
  const binaryName = opts.binaryName ?? "wi-impl";
  return exclusive(() =>
    captured(async () => {
      const { args, outputMode, envError, globals } = resolveGlobalFlags(withGlobalArgs(argv, opts));
      if (envError) return globalErrorOutcome(binaryName, outputMode, envError, globals.startedAt);
      return dispatchCommand([name, ...args], { [name]: module }, outputMode, binaryName, opts.helpResolver, {
        globals,
        base: -1,
      });
    })
  );
}

/** Run a full argv (e.g. `["ad", "show", "x"]`) through the namespaced CLI routing, in-process. */
export function runCliInProcess(
  options: NamespacedCliOptions,
  argv: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  return exclusive(() => captured(() => dispatchNamespaced(withGlobalArgs(argv, opts), options)));
}
