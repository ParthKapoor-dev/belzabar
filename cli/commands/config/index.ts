import readline from "readline";
import {
  CliError,
  ok,
  Config,
  loadConfigFileRaw,
  writeConfigFile,
  loadSession,
  login,
  type BelzConfigFile,
  type CommandModule,
} from "@belzabar/core";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Interactive helpers ───────────────────────────────────────────────────────

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

async function promptWithDefault(rl: readline.Interface, label: string, current: string): Promise<string> {
  const display = current ? ` [${current}]` : "";
  const answer = await prompt(rl, `  ${label}${display}: `);
  return answer.trim() || current;
}

async function runEditTui(): Promise<ConfigEditData> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const close = () => rl.close();

  try {
    const cfg = loadConfigFileRaw();
    const envs = cfg.environments ?? {};
    const envNames = Object.keys(envs);

    console.log("\nBelzabar Config Editor");
    console.log("──────────────────────");

    // Build menu
    const menuItems: string[] = [];
    for (const name of envNames) {
      menuItems.push(`Edit '${name}'`);
    }
    menuItems.push("Add new environment");
    if (envNames.length > 0) menuItems.push("Remove an environment");
    menuItems.push("Quit");

    console.log("\nWhat would you like to do?\n");
    menuItems.forEach((item, i) => console.log(`  [${i + 1}] ${item}`));
    console.log();

    const choiceStr = await prompt(rl, "Choice: ");
    const choice = parseInt(choiceStr.trim(), 10);

    if (!choice || choice < 1 || choice > menuItems.length) {
      console.log("Invalid choice. Aborting.");
      close();
      return { action: "edit", saved: false };
    }

    const selectedLabel = menuItems[choice - 1];

    // Quit
    if (selectedLabel === "Quit") {
      close();
      return { action: "edit", saved: false };
    }

    // Remove
    if (selectedLabel === "Remove an environment") {
      console.log("\nSelect environment to remove:\n");
      envNames.forEach((name, i) => console.log(`  [${i + 1}] ${name}`));
      console.log();
      const removeChoiceStr = await prompt(rl, "Choice: ");
      const removeChoice = parseInt(removeChoiceStr.trim(), 10);
      if (!removeChoice || removeChoice < 1 || removeChoice > envNames.length) {
        console.log("Invalid choice. Aborting.");
        close();
        return { action: "edit", saved: false };
      }
      const envToRemove = envNames[removeChoice - 1];
      const confirm = await prompt(rl, `\n  Remove '${envToRemove}'? [y/N]: `);
      if (confirm.trim().toLowerCase() !== "y") {
        console.log("Cancelled.");
        close();
        return { action: "edit", saved: false };
      }
      const updated: BelzConfigFile = { ...cfg, environments: { ...envs } };
      delete updated.environments![envToRemove];
      writeConfigFile(updated);
      console.log(`\n✓ Removed '${envToRemove}' from config.`);
      close();
      return { action: "edit", saved: true, env: envToRemove };
    }

    // Add new environment
    if (selectedLabel === "Add new environment") {
      console.log("\nAdd new environment:\n");
      const name = (await prompt(rl, "  Environment name (e.g. nsm-staging): ")).trim();
      if (!name) {
        console.log("Name cannot be empty. Aborting.");
        close();
        return { action: "edit", saved: false };
      }
      const url  = (await prompt(rl, "  Base URL: ")).trim();
      const user = (await prompt(rl, "  Username: ")).trim();
      const pass = (await prompt(rl, "  Password (plain text, will be base64-encoded): ")).trim();

      const updated: BelzConfigFile = {
        ...cfg,
        environments: {
          ...envs,
          [name]: {
            ...(url  ? { url }  : {}),
            ...(user ? { user } : {}),
            ...(pass ? { password: btoa(pass) } : {}),
          },
        },
      };
      writeConfigFile(updated);
      console.log(`\n✓ Added '${name}' to config.`);
      close();
      return { action: "edit", saved: true, env: name };
    }

    // Edit existing environment
    const envName = selectedLabel.replace(/^Edit '/, "").replace(/'$/, "");
    const current = envs[envName] ?? {};

    console.log(`\nEditing '${envName}' (press Enter to keep current value):\n`);

    const newUrl  = await promptWithDefault(rl, "Base URL",  current.url  ?? "");
    const newUser = await promptWithDefault(rl, "Username",  current.user ?? "");

    const pwdHint = current.password ? "(currently set)" : "(not set)";
    const newPassRaw = (await prompt(rl, `  Password ${pwdHint} (leave blank to keep): `)).trim();
    const newPass = newPassRaw ? btoa(newPassRaw) : current.password;

    const updatedEnv: { url?: string; user?: string; password?: string } = {
      ...(newUrl  ? { url: newUrl }   : {}),
      ...(newUser ? { user: newUser } : {}),
      ...(newPass ? { password: newPass } : {}),
    };

    const updated: BelzConfigFile = {
      ...cfg,
      environments: { ...envs, [envName]: updatedEnv },
    };
    writeConfigFile(updated);
    console.log(`\n✓ Saved config for '${envName}'.`);
    close();
    return { action: "edit", saved: true, env: envName };

  } catch (err) {
    close();
    throw err;
  }
}

// ── Command ───────────────────────────────────────────────────────────────────

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
      // The TUI already printed its own success message during the interactive flow
    }
  },
};

export default command;
