import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  CliError,
  ok,
  writeConfigFile,
  loadConfigFileRaw,
  lifecycle,
  prompts,
  term,
  type BelzConfigFile,
  type CommandModule,
} from "@belzabar/core";

// Picocolors-shaped alias over the unified belz theme.
const pc = {
  dim: term.dim,
  bold: term.bold,
  green: term.success,
  red: term.danger,
  cyan: term.accent,
};

interface SetupArgs {
  envFile?: string;
  force: boolean;
}

interface SetupEnvSummary {
  name: string;
  url: string;
  hasUser: boolean;
  hasPassword: boolean;
}

interface SetupData {
  configPath: string;
  envs: SetupEnvSummary[];
  teamworkConfigured: boolean;
}

const BUILTIN_ENVS: Array<{ name: string; url: string; userKey: string; passKey: string }> = [
  { name: "nsm-dev", url: "https://nsm-dev.nc.verifi.dev", userKey: "NSM_DEV_USER", passKey: "NSM_DEV_PASSWORD" },
  { name: "nsm-qa",  url: "https://nsm-qa.nc.verifi.dev",  userKey: "NSM_QA_USER",  passKey: "NSM_QA_PASSWORD" },
  { name: "nsm-uat", url: "https://nsm-uat.nc.verifi.dev", userKey: "NSM_UAT_USER", passKey: "NSM_UAT_PASSWORD" },
];

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function toBase64(value: string): string {
  if (!value) return "";
  try {
    // If it already decodes to printable text, assume already base64.
    const decoded = atob(value);
    if (decoded && /^[\x20-\x7e]+$/.test(decoded)) return value;
  } catch { /* not base64 */ }
  return btoa(value);
}

function buildSummaryBody(envs: BelzConfigFile["environments"], tw: BelzConfigFile["teamwork"]): string {
  const lines: string[] = [pc.bold("Environments")];
  for (const { name } of BUILTIN_ENVS) {
    const entry = envs?.[name];
    const user = entry?.user ? entry.user : pc.dim("(not set)");
    const pwd = entry?.password ? pc.green("set") : pc.red("unset");
    lines.push(`  ${pc.cyan(name.padEnd(9))} user: ${user}   password: ${pwd}`);
  }
  lines.push("");
  lines.push(pc.bold("Teamwork"));
  if (tw?.email) {
    lines.push(`  Email:    ${tw.email}`);
    lines.push(`  Password: ${tw.password ? pc.green("set") : pc.red("unset")}`);
  } else {
    lines.push(`  ${pc.dim("Not configured.")}`);
  }
  return lines.join("\n");
}

const command: CommandModule<SetupArgs, SetupData> = {
  schema: "belz.setup",

  parseArgs(args) {
    const parsed: SetupArgs = { force: false };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--env-file") {
        const next = args[i + 1];
        if (!next) throw new CliError("--env-file requires a path argument.", { code: "MISSING_ARG" });
        parsed.envFile = next;
        i++;
      } else if (a === "--force") {
        parsed.force = true;
      } else {
        throw new CliError(`Unknown flag: ${a}`, { code: "UNKNOWN_FLAG" });
      }
    }
    return parsed;
  },

  async execute(args, context) {
    if (context.outputMode === "llm" && !args.envFile) {
      throw new CliError(
        "Interactive setup is not supported with --llm. Pass --env-file <path> to run non-interactively.",
        { code: "INTERACTIVE_NOT_SUPPORTED" },
      );
    }

    const existing = loadConfigFileRaw();
    const existingHasEnvs = Object.keys(existing.environments ?? {}).length > 0;

    if (existingHasEnvs && !args.force && context.outputMode === "human") {
      lifecycle.note(
        "Existing Configuration",
        buildSummaryBody(existing.environments, (existing as any).teamwork),
      );
      const overwrite = await prompts.confirm({
        message: "Overwrite the existing config?",
        initialValue: false,
      });
      if (!overwrite) {
        throw new CliError("Aborted: existing config preserved.", { code: "SETUP_ABORTED" });
      }
    }

    // Gather credentials ------------------------------------------------------
    const envs: Record<string, { url: string; user?: string; password?: string }> = {};
    let tw: { email?: string; password?: string } | undefined;

    let envFileValues: Record<string, string> | null = null;
    if (args.envFile) {
      if (!existsSync(args.envFile)) {
        throw new CliError(`Env file not found: ${args.envFile}`, { code: "ENV_FILE_NOT_FOUND" });
      }
      envFileValues = parseDotEnv(readFileSync(args.envFile, "utf-8"));
    } else if (context.outputMode === "human") {
      const useFile = await prompts.confirm({
        message: "Load credentials from a .env file?",
        initialValue: false,
      });
      if (useFile) {
        const path = await prompts.text({
          message: "Path to .env file",
          validate: (v) => (v.trim() ? undefined : "Path cannot be empty."),
        });
        if (!existsSync(path)) {
          throw new CliError(`Env file not found: ${path}`, { code: "ENV_FILE_NOT_FOUND" });
        }
        envFileValues = parseDotEnv(readFileSync(path, "utf-8"));
      }
    }

    for (const envDef of BUILTIN_ENVS) {
      const { name, url, userKey, passKey } = envDef;
      const entry: { url: string; user?: string; password?: string } = { url };

      let user: string;
      let pass: string;
      if (envFileValues) {
        user = envFileValues[userKey] ?? "";
        pass = envFileValues[passKey] ?? "";
      } else {
        lifecycle.note(name, `URL: ${url}\nLeave blank to skip this environment.`);
        user = await prompts.text({ message: `Username for ${name}` });
        pass = user
          ? await prompts.password({ message: `Password for ${name}` })
          : "";
      }

      if (user) entry.user = user;
      if (pass) entry.password = toBase64(pass);
      envs[name] = entry;
    }

    // Teamwork (optional) -----------------------------------------------------
    if (envFileValues) {
      const email = envFileValues["TEAMWORK_EMAIL"];
      const password = envFileValues["TEAMWORK_PASSWORD"];
      if (email || password) {
        tw = {};
        if (email) tw.email = email;
        if (password) tw.password = toBase64(password);
      }
    } else if (context.outputMode === "human") {
      const addTeamwork = await prompts.confirm({
        message: "Configure Teamwork credentials now?",
        initialValue: false,
      });
      if (addTeamwork) {
        const email = await prompts.text({
          message: "Teamwork email",
          validate: (v) => (v.includes("@") ? undefined : "Must be an email address."),
        });
        const password = await prompts.password({ message: "Teamwork password" });
        tw = {};
        if (email) tw.email = email;
        if (password) tw.password = toBase64(password);
      }
    }

    // Summary + confirm -------------------------------------------------------
    if (context.outputMode === "human") {
      lifecycle.note("Review", buildSummaryBody(envs, tw));
      const confirmed = await prompts.confirm({
        message: "Write this configuration to ~/.belz/config.json?",
        initialValue: true,
      });
      if (!confirmed) {
        throw new CliError("Aborted: config was not written.", { code: "SETUP_ABORTED" });
      }
    }

    // Preserve non-credential sections (jenkins, belz install metadata,
    // web/extension state) — setup only owns environments + teamwork.
    const newConfig: BelzConfigFile = { ...existing, environments: envs };
    if (tw) (newConfig as any).teamwork = tw;
    writeConfigFile(newConfig);

    const summary: SetupData = {
      configPath: join(homedir(), ".belz", "config.json"),
      envs: BUILTIN_ENVS.map(({ name }) => ({
        name,
        url: envs[name]?.url ?? "",
        hasUser: !!envs[name]?.user,
        hasPassword: !!envs[name]?.password,
      })),
      teamworkConfigured: !!tw,
    };

    if (context.outputMode === "human") {
      lifecycle.outro(`Config written to ${summary.configPath}`);
    }

    return ok(summary);
  },

  presentHuman(envelope, ui) {
    // outro was already printed inside execute(); just show a table summary on success.
    if (!envelope.ok) return;
    const data = envelope.data as SetupData;
    ui.table(
      ["Environment", "User", "Password"],
      data.envs.map((e) => [
        e.name,
        e.hasUser ? "✓" : "—",
        e.hasPassword ? "✓" : "—",
      ]),
    );
    if (data.teamworkConfigured) {
      ui.success("Teamwork credentials saved.");
    }
  },
};

export default command;
