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
  fromEnv: boolean;
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
  jenkinsConfigured: boolean;
}

// Built-in NSM envs have known URLs and a legacy NSM_*_USER/PASSWORD key shape.
const BUILTIN_ENVS: Array<{ name: string; url: string; userKey: string; passKey: string }> = [
  { name: "nsm-dev", url: "https://nsm-dev.nc.verifi.dev", userKey: "NSM_DEV_USER", passKey: "NSM_DEV_PASSWORD" },
  { name: "nsm-qa",  url: "https://nsm-qa.nc.verifi.dev",  userKey: "NSM_QA_USER",  passKey: "NSM_QA_PASSWORD" },
  { name: "nsm-uat", url: "https://nsm-uat.nc.verifi.dev", userKey: "NSM_UAT_USER", passKey: "NSM_UAT_PASSWORD" },
];
const BUILTIN_URLS: Record<string, string> = Object.fromEntries(BUILTIN_ENVS.map((e) => [e.name, e.url]));

// Generic, project-agnostic env keys: BELZ_ENV_<NAME>_{URL,USER,PASSWORD,PROJECT}
// where <NAME> maps to an env name lowercased with `_`→`-` (BELZ_ENV_YS_QA_URL
// → "ys-qa"). This is how non-NSM projects (and nsm-stage/prod) are configured
// non-interactively — e.g. from a cloud environment's variables.
const GENERIC_ENV_RE = /^BELZ_ENV_(.+)_(URL|USER|PASSWORD|PROJECT)$/;

type EnvEntry = { url?: string; user?: string; password?: string; project?: string };

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m || !m[1]) continue;
    let value = m[2] ?? "";
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

/** Group BELZ_ENV_<NAME>_* keys into per-env entries (passwords base64-encoded). */
function collectGenericEnvs(values: Record<string, string>): Record<string, EnvEntry> {
  const grouped: Record<string, EnvEntry> = {};
  for (const [key, val] of Object.entries(values)) {
    if (!val) continue;
    const m = key.match(GENERIC_ENV_RE);
    if (!m || !m[1] || !m[2]) continue;
    const name = m[1].toLowerCase().replace(/_/g, "-");
    const field = m[2].toUpperCase();
    const entry: EnvEntry = grouped[name] ?? {};
    grouped[name] = entry;
    if (field === "URL") entry.url = val;
    else if (field === "USER") entry.user = val;
    else if (field === "PASSWORD") entry.password = toBase64(val);
    else if (field === "PROJECT") entry.project = val;
  }
  return grouped;
}

/** Build the full config from a flat key/value map (env file or process.env). */
function buildConfigFromValues(values: Record<string, string>): {
  envs: Record<string, EnvEntry>;
  tw?: { email?: string; password?: string };
  jenkins?: { baseUrl?: string; user?: string; password?: string; migrationJob?: string };
} {
  const envs: Record<string, EnvEntry> = {};

  // 1. Built-in NSM envs via the legacy NSM_*_USER/PASSWORD keys.
  for (const { name, url, userKey, passKey } of BUILTIN_ENVS) {
    const user = values[userKey] ?? "";
    const pass = values[passKey] ?? "";
    if (user || pass) {
      const entry: EnvEntry = { url };
      if (user) entry.user = user;
      if (pass) entry.password = toBase64(pass);
      envs[name] = entry;
    }
  }

  // 2. Generic BELZ_ENV_<NAME>_* envs (any project). Falls back to a built-in
  //    URL when the name is a known built-in and no URL was supplied.
  for (const [name, g] of Object.entries(collectGenericEnvs(values))) {
    const url = g.url ?? BUILTIN_URLS[name];
    if (!url) continue; // an env without a URL isn't usable — skip it
    envs[name] = { ...envs[name], ...g, url };
  }

  // 3. Jenkins.
  let jenkins: { baseUrl?: string; user?: string; password?: string; migrationJob?: string } | undefined;
  const jkUrl = values["BELZ_JENKINS_URL"];
  const jkUser = values["BELZ_JENKINS_USER"];
  const jkPass = values["BELZ_JENKINS_PASSWORD"];
  const jkJob = values["BELZ_JENKINS_JOB"];
  if (jkUrl || jkUser || jkPass || jkJob) {
    jenkins = {};
    if (jkUrl) jenkins.baseUrl = jkUrl;
    if (jkUser) jenkins.user = jkUser;
    if (jkPass) jenkins.password = toBase64(jkPass);
    if (jkJob) jenkins.migrationJob = jkJob;
  }

  // 4. Teamwork.
  let tw: { email?: string; password?: string } | undefined;
  const email = values["TEAMWORK_EMAIL"];
  const twPass = values["TEAMWORK_PASSWORD"];
  if (email || twPass) {
    tw = {};
    if (email) tw.email = email;
    if (twPass) tw.password = toBase64(twPass);
  }

  return { envs, tw, jenkins };
}

function buildSummaryBody(
  envs: BelzConfigFile["environments"],
  tw: BelzConfigFile["teamwork"],
  jenkins?: BelzConfigFile["jenkins"],
): string {
  const lines: string[] = [pc.bold("Environments")];
  const names = Object.keys(envs ?? {});
  if (names.length === 0) {
    lines.push(`  ${pc.dim("(none)")}`);
  } else {
    for (const name of names) {
      const entry = envs?.[name];
      const user = entry?.user ? entry.user : pc.dim("(not set)");
      const pwd = entry?.password ? pc.green("set") : pc.red("unset");
      lines.push(`  ${pc.cyan(name.padEnd(10))} user: ${user}   password: ${pwd}`);
    }
  }
  lines.push("");
  lines.push(pc.bold("Teamwork"));
  lines.push(tw?.email ? `  Email: ${tw.email}   Password: ${tw.password ? pc.green("set") : pc.red("unset")}` : `  ${pc.dim("Not configured.")}`);
  lines.push("");
  lines.push(pc.bold("Jenkins"));
  lines.push(jenkins?.baseUrl || jenkins?.user
    ? `  URL: ${jenkins.baseUrl ?? pc.dim("(not set)")}   User: ${jenkins.user ?? pc.dim("(not set)")}   Password: ${jenkins.password ? pc.green("set") : pc.red("unset")}`
    : `  ${pc.dim("Not configured.")}`);
  return lines.join("\n");
}

const command: CommandModule<SetupArgs, SetupData> = {
  schema: "belz.setup",

  parseArgs(args) {
    const parsed: SetupArgs = { force: false, fromEnv: false };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--env-file") {
        const next = args[i + 1];
        if (!next) throw new CliError("--env-file requires a path argument.", { code: "MISSING_ARG" });
        parsed.envFile = next;
        i++;
      } else if (a === "--from-env") {
        parsed.fromEnv = true;
      } else if (a === "--force") {
        parsed.force = true;
      } else {
        throw new CliError(`Unknown flag: ${a}`, { code: "UNKNOWN_FLAG" });
      }
    }
    return parsed;
  },

  async execute(args, context) {
    const nonInteractive = args.fromEnv || !!args.envFile;
    if (context.outputMode === "llm" && !nonInteractive) {
      throw new CliError(
        "Interactive setup is not supported with --llm. Pass --env-file <path> or --from-env to run non-interactively.",
        { code: "INTERACTIVE_NOT_SUPPORTED" },
      );
    }

    const existing = loadConfigFileRaw();
    const existingHasEnvs = Object.keys(existing.environments ?? {}).length > 0;

    if (existingHasEnvs && !args.force && context.outputMode === "human") {
      lifecycle.note(
        "Existing Configuration",
        buildSummaryBody(existing.environments, (existing as any).teamwork, existing.jenkins),
      );
      const overwrite = await prompts.confirm({ message: "Overwrite the existing config?", initialValue: false });
      if (!overwrite) {
        throw new CliError("Aborted: existing config preserved.", { code: "SETUP_ABORTED" });
      }
    }

    let envs: Record<string, EnvEntry> = {};
    let tw: { email?: string; password?: string } | undefined;
    let jenkins: { baseUrl?: string; user?: string; password?: string; migrationJob?: string } | undefined;

    // Non-interactive source: process.env (--from-env) or a .env file.
    let values: Record<string, string> | null = null;
    if (args.fromEnv) {
      values = { ...process.env } as Record<string, string>;
    } else if (args.envFile) {
      if (!existsSync(args.envFile)) {
        throw new CliError(`Env file not found: ${args.envFile}`, { code: "ENV_FILE_NOT_FOUND" });
      }
      values = parseDotEnv(readFileSync(args.envFile, "utf-8"));
    } else if (context.outputMode === "human") {
      const useFile = await prompts.confirm({ message: "Load credentials from a .env file?", initialValue: false });
      if (useFile) {
        const path = await prompts.text({ message: "Path to .env file", validate: (v) => (v.trim() ? undefined : "Path cannot be empty.") });
        if (!existsSync(path)) throw new CliError(`Env file not found: ${path}`, { code: "ENV_FILE_NOT_FOUND" });
        values = parseDotEnv(readFileSync(path, "utf-8"));
      }
    }

    if (values) {
      ({ envs, tw, jenkins } = buildConfigFromValues(values));
    } else {
      // Interactive prompts for the built-in NSM envs + Teamwork.
      for (const { name, url } of BUILTIN_ENVS) {
        lifecycle.note(name, `URL: ${url}\nLeave blank to skip this environment.`);
        const user = await prompts.text({ message: `Username for ${name}` });
        const pass = user ? await prompts.password({ message: `Password for ${name}` }) : "";
        const entry: EnvEntry = { url };
        if (user) entry.user = user;
        if (pass) entry.password = toBase64(pass);
        if (user || pass) envs[name] = entry;
      }
      const addTeamwork = await prompts.confirm({ message: "Configure Teamwork credentials now?", initialValue: false });
      if (addTeamwork) {
        const email = await prompts.text({ message: "Teamwork email", validate: (v) => (v.includes("@") ? undefined : "Must be an email address.") });
        const password = await prompts.password({ message: "Teamwork password" });
        tw = {};
        if (email) tw.email = email;
        if (password) tw.password = toBase64(password);
      }
    }

    if (Object.keys(envs).length === 0) {
      throw new CliError(
        "No environments resolved. Provide NSM_*_USER/PASSWORD or BELZ_ENV_<NAME>_{URL,USER,PASSWORD} values.",
        { code: "SETUP_NO_ENVS" },
      );
    }

    if (context.outputMode === "human" && !nonInteractive) {
      lifecycle.note("Review", buildSummaryBody(envs, tw, jenkins));
      const confirmed = await prompts.confirm({ message: "Write this configuration to ~/.belz/config.json?", initialValue: true });
      if (!confirmed) {
        throw new CliError("Aborted: config was not written.", { code: "SETUP_ABORTED" });
      }
    }

    // Merge over existing config so non-credential sections (belz install
    // metadata, web/extension state) survive. We DO own environments + teamwork
    // + jenkins, but only overwrite jenkins/teamwork when new values were given.
    const newConfig: BelzConfigFile = { ...existing, environments: envs };
    if (tw) (newConfig as any).teamwork = tw;
    if (jenkins) newConfig.jenkins = jenkins;
    writeConfigFile(newConfig);

    const summary: SetupData = {
      configPath: join(homedir(), ".belz", "config.json"),
      envs: Object.entries(envs).map(([name, e]) => ({
        name,
        url: e.url ?? "",
        hasUser: !!e.user,
        hasPassword: !!e.password,
      })),
      teamworkConfigured: !!tw,
      jenkinsConfigured: !!jenkins,
    };

    if (context.outputMode === "human") {
      lifecycle.outro(`Config written to ${summary.configPath}`);
    }

    return ok(summary);
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as SetupData;
    ui.table(
      ["Environment", "User", "Password"],
      data.envs.map((e) => [e.name, e.hasUser ? "✓" : "—", e.hasPassword ? "✓" : "—"]),
    );
    if (data.teamworkConfigured) ui.success("Teamwork credentials saved.");
    if (data.jenkinsConfigured) ui.success("Jenkins credentials saved.");
  },
};

export default command;
