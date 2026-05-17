import {
  CliError,
  ok,
  Config,
  loadConfigFileRaw,
  writeConfigFile,
  loadSession,
  login,
  term,
  lifecycle,
  prompts,
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

interface ConfigGetArgs   { action: "get" }
interface ConfigTokenArgs { action: "token" }
interface ConfigEditArgs  { action: "edit" }

type ConfigArgs = ConfigGetArgs | ConfigTokenArgs | ConfigEditArgs;

interface ConfigGetData {
  action: "get";
  env: string;
  url: string;
  user: string;
  passwordSource: "file" | "env" | "none";
  token: string | null;
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

type EditChoice = "edit" | "add" | "remove" | "teamwork" | "exit";

function buildSummaryBody(cfg: BelzConfigFile): string {
  const envs = cfg.environments ?? {};
  const tw = (cfg as any).teamwork;
  const lines: string[] = [];

  const envNames = Object.keys(envs);
  if (envNames.length === 0) {
    lines.push(pc.dim("No environments configured."));
  } else {
    lines.push(pc.bold("Environments"));
    for (const name of envNames) {
      const e = envs[name]!;
      const url = e.url ?? pc.dim("(default)");
      const user = e.user ?? pc.dim("(not set)");
      const pwd = e.password ? pc.green("set") : pc.red("unset");
      lines.push(`  ${pc.cyan(name)}  ${url}  ${user}  password:${pwd}`);
    }
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

async function runEditTui(): Promise<ConfigEditData> {
  const cfg = loadConfigFileRaw();

  lifecycle.intro("Belzabar Config Editor");

  const choice = await prompts.select<EditChoice>({
    message: "What would you like to do?",
    options: [
      { label: "Edit an environment",        value: "edit" },
      { label: "Add new environment",        value: "add" },
      { label: "Remove an environment",      value: "remove" },
      { label: "Edit Teamwork credentials",  value: "teamwork" },
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

    const updatedEnv: Record<string, string> = {};
    if (newUrl)  updatedEnv.url  = newUrl;
    if (newUser) updatedEnv.user = newUser;
    if (newPass) updatedEnv.password = btoa(newPass);
    else if (current.password) updatedEnv.password = current.password;

    writeConfigFile({ ...cfg, environments: { ...envs, [envName]: updatedEnv } });
    lifecycle.outro(`Saved configuration for '${envName}'.`);
    return { action: "edit", saved: true, env: envName };
  }

  if (choice === "add") {
    const name = await prompts.text({
      message: "Environment name (e.g. nsm-staging)",
      validate: (v) => (v.trim() ? undefined : "Name cannot be empty."),
    });
    const url = await prompts.text({ message: "Base URL", placeholder: "https://…" });
    const user = await prompts.text({ message: "Username" });
    const pass = await prompts.password({ message: "Password" });

    const entry: Record<string, string> = {};
    if (url)  entry.url = url;
    if (user) entry.user = user;
    if (pass) entry.password = btoa(pass);

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

  // teamwork
  const tw = (cfg as any).teamwork ?? {};
  const email = await prompts.text({
    message: `Email${tw.email ? ` (current: ${tw.email})` : ""}`,
    defaultValue: tw.email ?? "",
  });
  const passRaw = await prompts.password({
    message: tw.password ? "Password (leave blank to keep current)" : "Password",
  });

  const teamwork: Record<string, string> = {};
  if (email) teamwork.email = email;
  if (passRaw) teamwork.password = btoa(passRaw);
  else if (tw.password) teamwork.password = tw.password;

  writeConfigFile({ ...cfg, teamwork } as BelzConfigFile);
  lifecycle.outro("Saved Teamwork credentials.");
  return { action: "edit", saved: true };
}

const command: CommandModule<ConfigArgs, ConfigData> = {
  schema: "belz.config",

  parseArgs(args) {
    const sub = args[0];

    if (!sub || sub === "--help" || sub === "-h") {
      throw new CliError(
        "Usage: belz config <subcommand>\nSubcommands: get, token, edit\nRun 'belz config --help' for details.",
        { code: "MISSING_SUBCOMMAND" }
      );
    }

    if (sub === "get")   return { action: "get" };
    if (sub === "token") return { action: "token" };
    if (sub === "edit")  return { action: "edit" };

    throw new CliError(`Unknown config subcommand: '${sub}'. Available: get, token, edit`, {
      code: "UNKNOWN_SUBCOMMAND",
    });
  },

  async execute(args) {
    const env = Config.activeEnv;

    if (args.action === "get") {
      const rawFile = loadConfigFileRaw();
      const fileEnv = rawFile.environments?.[env.name];
      const session = await loadSession();

      const passwordSource: "file" | "env" | "none" = fileEnv?.password
        ? "file"
        : env.credentials.passwordEncoded
        ? "env"
        : "none";

      return ok<ConfigGetData>({
        action: "get",
        env: env.name,
        url: env.baseUrl,
        user: env.credentials.loginId || "(not set)",
        passwordSource,
        token: session?.token ?? null,
      });
    }

    if (args.action === "token") {
      let session = await loadSession();
      if (!session) {
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
      const tokenLabel = d.token
        ? d.token.length > 60 ? `${d.token.slice(0, 60)}...` : d.token
        : "(no cached session)";

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
