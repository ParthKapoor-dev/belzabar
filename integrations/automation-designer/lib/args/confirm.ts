import { confirmWrite, logWriteIntent } from "@belzabar/core";

export interface ConfirmOpts {
  yes: boolean;
  outputMode: "human" | "llm";
  action: string;
  details: Array<[string, string]>;
}

/** AD write gate: `AD_CONFIRMATION_REQUIRED` in --llm without --yes, else a "Proceed?" prompt. */
export async function requireConfirmation(opts: ConfirmOpts): Promise<void> {
  await confirmWrite({
    ...opts,
    codePrefix: "AD",
    requiredMessage: `Confirmation required for ${opts.action}. Pass --yes in --llm mode to bypass.`,
  });
}

/** `[belz ad write] {...}` on stderr, naming the env the write actually targets. */
export function logIntent(method: string, path: string, meta: Record<string, unknown> = {}): void {
  logWriteIntent("ad", { method, path }, meta, { withEnv: true });
}
