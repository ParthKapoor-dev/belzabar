import { CliError, lifecycle, prompts } from "@belzabar/core";

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
  if (opts.yes) return;

  if (opts.outputMode === "llm") {
    throw new CliError(
      `Confirmation required to ${opts.action}. Pass --yes to proceed — but only after the EXACT comment text has been validated by the user in chat.`,
      { code: "TW_CONFIRMATION_REQUIRED", details: { action: opts.action, details: opts.details } },
    );
  }

  const pad = opts.details.length ? Math.max(...opts.details.map(([k]) => k.length)) : 0;
  const body = opts.details.map(([k, v]) => `${k.padEnd(pad)}  ${v}`).join("\n") || "(no details)";
  lifecycle.note(`About to ${opts.action}`, body);

  const confirmed = await prompts.confirm({
    message: "Post this comment?",
    initialValue: false,
  });

  if (!confirmed) {
    throw new CliError("Aborted by user.", { code: "TW_USER_ABORT" });
  }
}

export function logIntent(method: string, path: string, meta: Record<string, unknown> = {}): void {
  const payload = JSON.stringify({ ts: new Date().toISOString(), method, path, ...meta });
  process.stderr.write(`[belz tw write] ${payload}\n`);
}
