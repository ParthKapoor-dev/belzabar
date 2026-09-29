import { confirmWrite, logWriteIntent } from "@belzabar/core";

export interface ConfirmOpts {
  yes: boolean;
  outputMode: "human" | "llm";
  action: string;
  details: Array<[string, string]>;
}

/**
 * Gate a write to Teamwork behind an explicit confirmation.
 *
 * In human mode it prints the full details (including the exact comment text)
 * and waits for a y/N prompt. In --llm mode it refuses unless --yes is passed —
 * and --yes must only ever be passed by an agent AFTER it has shown the exact
 * comment text to the user and gotten their validation in chat. A prior
 * go-ahead never counts; re-show and re-confirm before every post.
 */
export async function requireConfirmation(opts: ConfirmOpts): Promise<void> {
  await confirmWrite({
    ...opts,
    codePrefix: "TW",
    requiredMessage: `Confirmation required to ${opts.action}. Pass --yes to proceed — but only after the EXACT comment text has been validated by the user in chat.`,
    promptMessage: "Post this comment?",
  });
}

export function logIntent(method: string, path: string, meta: Record<string, unknown> = {}): void {
  logWriteIntent("tw", { method, path }, meta);
}
