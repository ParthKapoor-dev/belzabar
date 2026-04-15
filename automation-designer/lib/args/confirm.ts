// Interactive confirmation helper used by every AD write command.
//
// Rules:
//   - Human mode: prompt via inquirer unless --yes was passed.
//   - LLM mode: --yes is mandatory; otherwise throw AD_CONFIRMATION_REQUIRED
//     so tool-callers cannot accidentally mutate state from a script.
//   - Always log the intended call to stderr (the caller decides what to
//     include in the log line).

import { CliError } from "@belzabar/core";
import inquirer from "inquirer";

export interface ConfirmOpts {
  yes: boolean;
  outputMode: "human" | "llm";
  action: string;
  details: Array<[string, string]>;
}

export async function requireConfirmation(opts: ConfirmOpts): Promise<void> {
  if (opts.yes) return;

  if (opts.outputMode === "llm") {
    throw new CliError(
      `Confirmation required for ${opts.action}. Pass --yes in --llm mode to bypass.`,
      { code: "AD_CONFIRMATION_REQUIRED", details: { action: opts.action, details: opts.details } },
    );
  }

  console.log(`\nAbout to ${opts.action}:`);
  const pad = Math.max(...opts.details.map(([k]) => k.length));
  for (const [k, v] of opts.details) {
    console.log(`  ${k.padEnd(pad)}  ${v}`);
  }

  const { confirmed } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmed",
      message: "Proceed?",
      default: false,
    },
  ]);

  if (!confirmed) {
    throw new CliError("Aborted by user.", { code: "AD_USER_ABORT" });
  }
}

export function logIntent(
  method: string,
  path: string,
  meta: Record<string, unknown> = {},
): void {
  const envName = process.env.BELZ_ENV ?? "unknown";
  const payload = JSON.stringify({ ts: new Date().toISOString(), method, path, env: envName, ...meta });
  process.stderr.write(`[belz ad write] ${payload}\n`);
}
