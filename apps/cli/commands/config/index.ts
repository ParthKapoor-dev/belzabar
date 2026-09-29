import {
  CliError,
  ok,
  Config,
  loadConfigFileRaw,
  writeConfigFile,
  loadSession,
  login,
  isTokenExpired,
  jwtExpiry,
  encodeSecret,
  keepSecret,
  noEnvSelectedError,
  term,
  lifecycle,
  prompts,
  type BelzConfigFile,
  type CommandModule,
} from "@belzabar/core";
import { parseConfigArgs } from "./args";

export { args } from "./args";

// Picocolors-shaped alias over the unified belz theme.
const pc = {
  dim: term.dim,
  bold: term.bold,
  green: term.success,
  red: term.danger,
  cyan: term.accent,
};

interface ConfigGetArgs   { action: "get" }
interface ConfigTokenArgs { action: "token"; refresh?: boolean }
interface ConfigEditArgs  { action: "edit" }

type ConfigArgs = ConfigGetArgs | ConfigTokenArgs | ConfigEditArgs;

interface ConfigGetData {
  action: "get";
  env: string;
  url: string;
  user: string;
  passwordSource: "file" | "env" | "none";
  /** Never the token itself — only `config token` (explicit) prints it. */
  tokenPresent: boolean;
  /** ISO time the cached JWT expires, when it is a JWT with `exp`. */
  tokenExpiresAt: string | null;
  tokenExpired: boolean;
}

interface ConfigTokenData {
  action: "token";
  env: string;
  token: string;
}

interface ConfigEditData {
  action: "edit";
  saved: boolean;
  env?: string;
}

type ConfigData = ConfigGetData | ConfigTokenData | ConfigEditData;

type EditChoice = "edit" | "add" | "remove" | "default" | "teamwork" | "jenkins" | "exit";

function buildSummaryBody(cfg: BelzConfigFile): string {
  const envs = cfg.environments ?? {};
  const tw = (cfg as any).teamwork;
  const lines: string[] = [];

  const envNames = Object.keys(envs);
  if (envNames.length === 0) {
    lines.push(pc.dim("No environments configured."));
  } else {
    lines.push(`${pc.bold("Environments")}  ${pc.dim(`default: ${cfg.defaultEnv ?? "(none)"}`)}`);
    for (const name of envNames) {
      const e = envs[name]!;
      const url = e.url ?? pc.red("(no url)");
      const user = e.user ?? pc.dim("(not set)");
      const pwd = e.password ? pc.green("set") : pc.red("unset");
      lines.push(`  ${pc.cyan(name)}  ${url}  ${user}  password:${pwd}`);
    }
  }

  lines.push("");
  lines.push(pc.bold("Teamwork"));
  if (tw?.email || tw?.baseUrl) {
    lines.push(`  Site:     ${tw.baseUrl ?? pc.red("(not set)")}`);
    lines.push(`  Email:    ${tw.email ?? pc.dim("(not set)")}`);
    lines.push(`  Password: ${tw.password ? pc.green("set") : pc.red("unset")}`);
  } else {
    lines.push(`  ${pc.dim("Not configured.")}`);
  }

  lines.push("");
  lines.push(pc.bold("Jenkins"));
  const jk = cfg.jenkins;
  if (jk?.baseUrl || jk?.user) {
    lines.push(`  URL:      ${jk.baseUrl ?? pc.dim("(not set)")}`);
    lines.push(`  User:     ${jk.user ?? pc.dim("(not set)")}`);
    lines.push(`  Password: ${jk.password ? pc.green("set") : pc.red("unset")}`);
    lines.push(`  Job:      ${jk.migrationJob ?? pc.red("(not set — required by 'belz migrate')")}`);
  } else {
    lines.push(`  ${pc.dim("Not configured.")}`);
  }

  return lines.join("\n");
}

async function runEditTui(): Promise<ConfigEditData> {
  const cfg = loadConfigFileRaw();

  lifecycle.intro("Belzabar Config Editor");

  const choice = await prompts.select<EditChoice>({
    message: "What would you like to do?",
    options: [
      { label: "Edit an environment",        value: "edit" },
      { label: "Add new environment",        value: "add" },
      { label: "Remove an environment",      value: "remove" },
      { label: "Set default environment",    value: "default" },
      { label: "Edit Teamwork credentials",  value: "teamwork" },
      { label: "Edit Jenkins credentials",   value: "jenkins" },
      { label: "Exit",                        value: "exit" },
    ],
  });

  const envs = cfg.environments ?? {};
  const envNames = Object.keys(envs);

  if (choice === "exit") {
    lifecycle.outro("No changes made.");
    return { action: "edit", saved: false };
  }

  if (choice === "edit") {
    if (envNames.length === 0) {
      lifecycle.outro("No environments to edit. Add one first.");
      return { action: "edit", saved: false };
    }
    const envName = await prompts.select<string>({
      message: "Select environment to edit:",
      options: envNames.map((name) => ({ label: name, value: name })),
    });
    const current = envs[envName] ?? {};

    const newUrl = await prompts.text({
      message: `Base URL${current.url ? ` (current: ${current.url})` : ""}`,
      placeholder: current.url ?? "https://…",
      defaultValue: current.url ?? "",
    });
    const newUser = await prompts.text({
      message: `Username${current.user ? ` (current: ${current.user})` : ""}`,
      placeholder: current.user ?? "",
      defaultValue: current.user ?? "",
    });
    const newPass = await prompts.password({
      message: current.password ? "Password (leave blank to keep current)" : "Password",
    });

    // Keep every other field (project, …) — CORE-16. New passwords are stored
    // plain with an explicit encoding (D5; config.json is 0600).
    const { password: _p, passwordEncoding: _e, ...rest } = current;
    const updatedEnv = {
      ...rest,
      ...(newUrl ? { url: newUrl } : {}),
      ...(newUser ? { user: newUser } : {}),
      ...(newPass ? encodeSecret(newPass) : keepSecret(current)),
    };

    writeConfigFile({ ...cfg, environments: { ...envs, [envName]: updatedEnv } });
    lifecycle.outro(`Saved configuration for '${envName}'.`);
    return { action: "edit", saved: true, env: envName };
  }

  if (choice === "add") {
    const name = await prompts.text({
      message: "Environment name (e.g. dev, qa)",
      validate: (v) => (v.trim() ? undefined : "Name cannot be empty."),
    });
    const url = await prompts.text({ message: "Base URL", placeholder: "https://…" });
    const user = await prompts.text({ message: "Username" });
    const pass = await prompts.password({ message: "Password" });

    const entry = {
      ...(url ? { url } : {}),
      ...(user ? { user } : {}),
      ...(pass ? encodeSecret(pass) : {}),
    };

    writeConfigFile({ ...cfg, environments: { ...envs, [name]: entry } });
    lifecycle.outro(`Added environment '${name}'.`);
    return { action: "edit", saved: true, env: name };
  }

  if (choice === "remove") {
    if (envNames.length === 0) {
      lifecycle.outro("No environments to remove.");
      return { action: "edit", saved: false };
    }
    const envName = await prompts.select<string>({
      message: "Select environment to remove:",
      options: envNames.map((name) => ({ label: name, value: name })),
    });
    const yes = await prompts.confirm({
      message: `Remove '${envName}'?`,
      initialValue: false,
    });
    if (!yes) {
      lifecycle.outro("Cancelled.");
      return { action: "edit", saved: false };
    }
    const updated = { ...cfg, environments: { ...envs } };
    delete updated.environments![envName];
    writeConfigFile(updated);
    lifecycle.outro(`Removed environment '${envName}'.`);
    return { action: "edit", saved: true, env: envName };
  }

  if (choice === "default") {
    if (envNames.length === 0) {
      lifecycle.outro("No environments configured. Add one first.");
      return { action: "edit", saved: false };
    }
    const NONE = "\u0000none";
    const picked = await prompts.select<string>({
      message: `Default environment (used when --env is omitted)${cfg.defaultEnv ? ` — current: ${cfg.defaultEnv}` : ""}`,
      options: [
        ...envNames.map((name) => ({ label: name, value: name })),
        { label: "(none — always pass --env)", value: NONE },
      ],
      ...(cfg.defaultEnv && envNames.includes(cfg.defaultEnv) ? { initialValue: cfg.defaultEnv } : {}),
    });
    const updated: BelzConfigFile = { ...cfg };
    if (picked === NONE) delete updated.defaultEnv;
    else updated.defaultEnv = picked;
    writeConfigFile(updated);
    lifecycle.outro(picked === NONE ? "Cleared the default environment." : `Default environment: '${picked}'.`);
    return { action: "edit", saved: true, ...(picked === NONE ? {} : { env: picked }) };
  }

  if (choice === "teamwork") {
    const tw = cfg.teamwork ?? {};
    const twUrl = await prompts.text({
      message: `Site URL${tw.baseUrl ? ` (current: ${tw.baseUrl})` : ""}`,
      placeholder: tw.baseUrl ?? "https://yourcompany.teamwork.com",
      defaultValue: tw.baseUrl ?? "",
    });
    const email = await prompts.text({
      message: `Email${tw.email ? ` (current: ${tw.email})` : ""}`,
      defaultValue: tw.email ?? "",
    });
    const passRaw = await prompts.password({
      message: tw.password ? "Password (leave blank to keep current)" : "Password",
    });

    const { password: _tp, passwordEncoding: _te, ...twRest } = tw;
    const teamwork = {
      ...twRest,
      ...(twUrl ? { baseUrl: twUrl } : {}),
      ...(email ? { email } : {}),
      ...(passRaw ? encodeSecret(passRaw) : keepSecret(tw)),
    };

    writeConfigFile({ ...cfg, teamwork } as BelzConfigFile);
    lifecycle.outro("Saved Teamwork credentials.");
    return { action: "edit", saved: true };
  }

  // jenkins
  const jk = cfg.jenkins ?? {};
  const baseUrl = await prompts.text({
    message: `Base URL${jk.baseUrl ? ` (current: ${jk.baseUrl})` : ""}`,
    placeholder: jk.baseUrl ?? "https://jenkins.example.test",
    defaultValue: jk.baseUrl ?? "",
  });
  const jkUser = await prompts.text({
    message: `Username${jk.user ? ` (current: ${jk.user})` : ""}`,
    defaultValue: jk.user ?? "",
  });
  const jkPassRaw = await prompts.password({
    message: jk.password ? "Password / API token (leave blank to keep current)" : "Password / API token",
  });
  const job = await prompts.text({
    message: `Migration job${jk.migrationJob ? ` (current: ${jk.migrationJob})` : ""}`,
    placeholder: "Folder/db-migration",
    defaultValue: jk.migrationJob ?? "",
  });

  const { password: _jp, passwordEncoding: _je, ...jkRest } = jk;
  const jenkins = {
    ...jkRest,
    ...(baseUrl ? { baseUrl } : {}),
    ...(jkUser ? { user: jkUser } : {}),
    ...(jkPassRaw ? encodeSecret(jkPassRaw) : keepSecret(jk)),
    ...(job ? { migrationJob: job } : {}),
  };

  writeConfigFile({ ...cfg, jenkins } as BelzConfigFile);
  lifecycle.outro("Saved Jenkins credentials.");
  return { action: "edit", saved: true };
}

function tokenExpiresAt(token: string | undefined): string | null {
  if (!token) return null;
  const exp = jwtExpiry(token);
  return exp === null ? null : new Date(exp * 1000).toISOString();
}

const command: CommandModule<ConfigArgs, ConfigData> = {
  schema: "belz.config",

  parseArgs(argv) {
    return parseConfigArgs(argv);
  },

  async execute(args) {
    // config is not env-aware (edit needs no env), so get/token check the selection themselves.
    if ((args.action === "get" || args.action === "token") && Config.envSource === "none") {
      throw noEnvSelectedError();
    }
    const env = Config.activeEnv;

    if (args.action === "get") {
      const rawFile = loadConfigFileRaw();
      const fileEnv = rawFile.environments?.[env.name];
      const session = await loadSession();

      const passwordSource: "file" | "env" | "none" = fileEnv?.password ? "file" : "none";

      return ok<ConfigGetData>({
        action: "get",
        env: env.name,
        url: env.baseUrl,
        user: env.credentials.loginId || "(not set)",
        passwordSource,
        tokenPresent: !!session?.token,
        tokenExpiresAt: tokenExpiresAt(session?.token),
        tokenExpired: session?.token ? isTokenExpired(session.token, 0) : false,
      });
    }

    if (args.action === "token") {
      // Re-login when there is no session, the JWT `exp` has passed, or
      // --refresh was given — never hand a dead token to curl (CORE-10).
      let session = await loadSession();
      if (!session || args.refresh || isTokenExpired(session.token)) {
        session = await login();
      }
      return ok<ConfigTokenData>({
        action: "token",
        env: env.name,
        token: session.token,
      });
    }

    if (args.action === "edit") {
      const cfg = loadConfigFileRaw();
      lifecycle.note("Current Configuration", buildSummaryBody(cfg));
      const result = await runEditTui();
      return ok<ConfigEditData>(result);
    }

    throw new CliError("Unhandled config subcommand.", { code: "UNHANDLED_SUBCOMMAND" });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ConfigData;

    if (data.action === "get") {
      const d = data as ConfigGetData;
      const pwdLabel =
        d.passwordSource === "file"  ? "configured (config file)" :
        d.passwordSource === "env"   ? "configured (env var)" :
                                       "not set";
      const tokenLabel = !d.tokenPresent
        ? "(no cached session)"
        : d.tokenExpired
        ? `cached (expired${d.tokenExpiresAt ? ` ${d.tokenExpiresAt}` : ""}) — 'belz config token' re-logs in`
        : `cached${d.tokenExpiresAt ? ` (expires ${d.tokenExpiresAt})` : ""} — print it with 'belz config token'`;

      ui.text(`Config: ${d.env}`);
      ui.table(
        ["Field", "Value"],
        [
          ["URL",      d.url],
          ["User",     d.user],
          ["Password", pwdLabel],
          ["Token",    tokenLabel],
        ]
      );
      return;
    }

    if (data.action === "token") {
      const d = data as ConfigTokenData;
      process.stdout.write(d.token + "\n");
      return;
    }

    if (data.action === "edit") {
      const d = data as ConfigEditData;
      if (!d.saved) {
        ui.text("No changes made.");
      }
    }
  },
};

export default command;
