import { CliError, lifecycle, prompts } from "@belzabar/core";

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

  const pad = opts.details.length ? Math.max(...opts.details.map(([k]) => k.length)) : 0;
  const body = opts.details.map(([k, v]) => `${k.padEnd(pad)}  ${v}`).join("\n") || "(no details)";
  lifecycle.note(`About to ${opts.action}`, body);

  const confirmed = await prompts.confirm({
    message: "Proceed?",
    initialValue: false,
  });

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
