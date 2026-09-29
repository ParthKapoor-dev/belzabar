// Write confirmation and the stderr write-intent audit line, shared by every
// integration that writes (AD, PD, Teamwork, migrations). Each namespace keeps
// its own error codes, wording and prompt text through the options.

import { CliError } from "./command";
import { Config } from "./config";
import { lifecycle, prompts } from "./ui";

export interface ConfirmWriteOptions {
  /** `--yes` was passed: proceed without asking. */
  yes: boolean;
  outputMode: "human" | "llm";
  /** What is about to happen ("delete method X"); shown and put in the error details. */
  action: string;
  details: Array<[string, string]>;
  /** Code prefix: `AD` → `AD_CONFIRMATION_REQUIRED` / `AD_USER_ABORT`. None → unprefixed codes. */
  codePrefix?: string;
  /** Message of the confirmation-required error. */
  requiredMessage: string;
  /** Prompt text. Default "Proceed?". */
  promptMessage?: string;
  /** Also refuse (instead of prompting) when stdin is not a TTY. Default false (the prompt then fails with NO_TTY). */
  refuseWithoutTty?: boolean;
  /** Exit code of the user-abort error. Default: the CliError default. */
  abortExitCode?: number;
  /** Shape of `details.details` in the confirmation-required error: the pairs as given, or an object. Default "pairs". */
  detailsShape?: "pairs" | "object";
  /** Body shown when `details` is empty. Default "(no details)". */
  emptyBody?: string;
}

/**
 * Gate a write: `yes` proceeds; --llm (and, with `refuseWithoutTty`, a non-TTY)
 * throws `<prefix>_CONFIRMATION_REQUIRED`; otherwise the details are shown and
 * the user is asked (no → `<prefix>_USER_ABORT`).
 */
export async function confirmWrite(opts: ConfirmWriteOptions): Promise<void> {
  if (opts.yes) return;
  const code = (name: string) => (opts.codePrefix ? `${opts.codePrefix}_${name}` : name);

  if (opts.outputMode === "llm" || (opts.refuseWithoutTty && !process.stdin.isTTY)) {
    const details = opts.detailsShape === "object" ? Object.fromEntries(opts.details) : opts.details;
    throw new CliError(opts.requiredMessage, {
      code: code("CONFIRMATION_REQUIRED"),
      details: { action: opts.action, details },
    });
  }

  const pad = Math.max(0, ...opts.details.map(([k]) => k.length));
  const body = opts.details.map(([k, v]) => `${k.padEnd(pad)}  ${v}`).join("\n") || (opts.emptyBody ?? "(no details)");
  lifecycle.note(`About to ${opts.action}`, body);

  const confirmed = await prompts.confirm({ message: opts.promptMessage ?? "Proceed?", initialValue: false });
  if (!confirmed) {
    throw new CliError("Aborted by user.", {
      code: code("USER_ABORT"),
      ...(opts.abortExitCode !== undefined ? { exitCode: opts.abortExitCode } : {}),
    });
  }
}

/**
 * One stderr audit line per remote write: `[belz <ns> write] {"ts",...fields,"env"?,...meta}`.
 * `withEnv` adds the env the write really targets (`--env`, else the default env).
 */
export function logWriteIntent(
  ns: string,
  fields: Record<string, unknown>,
  meta: Record<string, unknown> = {},
  opts: { withEnv?: boolean } = {},
): void {
  const record: Record<string, unknown> = { ts: new Date().toISOString(), ...fields };
  if (opts.withEnv) {
    try {
      record.env = Config.activeEnv.name;
    } catch {
      record.env = "unknown";
    }
  }
  process.stderr.write(`[belz ${ns} write] ${JSON.stringify({ ...record, ...meta })}\n`);
}
