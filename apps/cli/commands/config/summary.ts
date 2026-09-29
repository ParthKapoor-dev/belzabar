// The human summary of a config.json shown by `belz config` and `belz setup`.
// Passwords are never printed, only whether one is set.

import { term, type BelzConfigFile } from "@belzabar/core";

/** Environments (with the default), Teamwork and Jenkins sections. */
export function configSummary(cfg: BelzConfigFile): string {
  const envs = cfg.environments ?? {};
  const tw = cfg.teamwork;
  const lines: string[] = [];

  const envNames = Object.keys(envs);
  if (envNames.length === 0) {
    lines.push(term.dim("No environments configured."));
  } else {
    lines.push(`${term.bold("Environments")}  ${term.dim(`default: ${cfg.defaultEnv ?? "(none)"}`)}`);
    for (const name of envNames) {
      const e = envs[name]!;
      const url = e.url ?? term.danger("(no url)");
      const user = e.user ?? term.dim("(not set)");
      const pwd = e.password ? term.success("set") : term.danger("unset");
      lines.push(`  ${term.accent(name)}  ${url}  ${user}  password:${pwd}`);
    }
  }

  lines.push("");
  lines.push(term.bold("Teamwork"));
  if (tw?.email || tw?.baseUrl) {
    lines.push(`  Site:     ${tw.baseUrl ?? term.danger("(not set)")}`);
    lines.push(`  Email:    ${tw.email ?? term.dim("(not set)")}`);
    lines.push(`  Password: ${tw.password ? term.success("set") : term.danger("unset")}`);
  } else {
    lines.push(`  ${term.dim("Not configured.")}`);
  }

  lines.push("");
  lines.push(term.bold("Jenkins"));
  const jk = cfg.jenkins;
  if (jk?.baseUrl || jk?.user) {
    lines.push(`  URL:      ${jk.baseUrl ?? term.dim("(not set)")}`);
    lines.push(`  User:     ${jk.user ?? term.dim("(not set)")}`);
    lines.push(`  Password: ${jk.password ? term.success("set") : term.danger("unset")}`);
    lines.push(`  Job:      ${jk.migrationJob ?? term.danger("(not set — required by 'belz migrate')")}`);
  } else {
    lines.push(`  ${term.dim("Not configured.")}`);
  }

  return lines.join("\n");
}
