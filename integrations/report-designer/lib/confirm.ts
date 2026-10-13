// The RD write gate and audit line (core confirmWrite / logWriteIntent).

import { confirmWrite, logWriteIntent } from "@belzabar/core";

interface ConfirmOpts {
  yes: boolean;
  outputMode: "human" | "llm";
  action: string;
  details: Array<[string, string]>;
}

/** `RD_CONFIRMATION_REQUIRED` in --llm without --yes, else a "Proceed?" prompt (no → `RD_USER_ABORT`). */
export async function requireConfirmation(opts: ConfirmOpts): Promise<void> {
  await confirmWrite({
    ...opts,
    codePrefix: "RD",
    requiredMessage: `Confirmation required to ${opts.action}. Pass --yes in --llm mode to bypass.`,
  });
}

/** `[belz rd write] {...}` on stderr, naming the env the write targets. */
export function logIntent(method: string, path: string, meta: Record<string, unknown> = {}): void {
  logWriteIntent("rd", { method, path }, meta, { withEnv: true });
}
