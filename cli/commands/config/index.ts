import readline from "readline";
import chalk from "chalk";
import Table from "cli-table3";
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

// ── Interactive TUI helpers ─────────────────────────────────────────────────

const RULE = chalk.dim("─".repeat(60));
const HEADER = (text: string) => chalk.bold.underline(text);
const DIM = (text: string) => chalk.dim(text);
const SUCCESS = (text: string) => chalk.green(`  ✅ ${text}`);
const WARN = (text: string) => chalk.yellow(`  ⚠  ${text}`);
const LABEL = (text: string) => chalk.bold(text);

function renderSelectOptions(options: string[], selectedIdx: number): void {
  for (let i = 0; i < options.length; i++) {
    if (i === selectedIdx) {
      process.stdout.write(chalk.cyan(`  ❯ ${options[i]}\n`));
    } else {
      process.stdout.write(chalk.dim(`    ${options[i]}\n`));
    }
  }
}

function clearLines(count: number): void {
  for (let i = 0; i < count; i++) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
  }
}

async function select(title: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    let idx = 0;
    process.stdout.write(`\n  ${LABEL(title)}\n`);
    renderSelectOptions(options, idx);

    const onData = (buf: Buffer): void => {
      const key = buf.toString();

      if (key === "\r" || key === "\n") {
        clearLines(options.length);
        process.stdout.write(chalk.cyan(`  ❯ ${options[idx]}\n`));
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(idx);
        return;
      }
      if (key === "\x1b[A") { // Up
        clearLines(options.length);
        idx = (idx - 1 + options.length) % options.length;
        renderSelectOptions(options, idx);
        return;
      }
      if (key === "\x1b[B") { // Down
        clearLines(options.length);
        idx = (idx + 1) % options.length;
        renderSelectOptions(options, idx);
        return;
      }
      if (key === "\x03") { // Ctrl-C
        process.stdout.write("\n");
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(-1);
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

async function askField(rl: readline.Interface, label: string, current?: string): Promise<string> {
  const hint = current ? DIM(` [${current}]`) : "";
  const answer = await ask(rl, `  ${LABEL(label)}${hint}${LABEL(":")}`);
  return answer.trim() || (current ?? "");
}

async function askPassword(rl: readline.Interface, hasExisting: boolean): Promise<string | null> {
  const hint = hasExisting ? DIM(" (leave blank to keep current)") : "";
  const answer = await ask(rl, `  ${LABEL("Password")}${hint}${LABEL(":")}`);
  const trimmed = answer.trim();
  if (!trimmed) return null; // keep existing
  return trimmed;
}

async function confirmAction(rl: readline.Interface, message: string): Promise<boolean> {
  const answer = await ask(rl, `  ${message} ${DIM("[y/N]")} `);
  return answer.trim().toLowerCase() === "y";
}

function printConfigSummary(cfg: BelzConfigFile): void {
  const envs = cfg.environments ?? {};
  const tw = (cfg as any).teamwork;

  console.log(`\n  ${HEADER("Current Configuration")}`);
  console.log(`  ${RULE}`);

  // Environments table
  const envNames = Object.keys(envs);
  if (envNames.length > 0) {
    console.log(`\n  ${LABEL("Environments")}`);
    const table = new Table({
      chars: {
        'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
        'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
        'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
        'right': '│', 'right-mid': '┤', 'middle': '│',
      },
      head: [chalk.cyan("Name"), chalk.cyan("URL"), chalk.cyan("User"), chalk.cyan("Password")],
      wordWrap: true,
      style: { 'padding-left': 1, 'padding-right': 1 },
    });
    for (const name of envNames) {
      const e = envs[name]!;
      table.push([
        name,
        e.url ?? DIM("(default)"),
        e.user ?? DIM("(not set)"),
        e.password ? chalk.green("Set") : chalk.red("Not set"),
      ]);
    }
    console.log(table.toString().split("\n").map(l => "  " + l).join("\n"));
  } else {
    console.log(`\n  ${DIM("No environments configured.")}`);
  }

  // Teamwork section
  console.log(`\n  ${LABEL("Teamwork")}`);
  if (tw?.email) {
    console.log(`  Email:    ${tw.email}`);
    console.log(`  Password: ${tw.password ? chalk.green("Set") : chalk.red("Not set")}`);
  } else {
    console.log(`  ${DIM("Not configured.")}`);
  }
  console.log();
}

// ── Main edit TUI ───────────────────────────────────────────────────────────

async function runEditTui(): Promise<ConfigEditData> {
  const cfg = loadConfigFileRaw();

  console.log(`\n  ${chalk.bold.cyan("Belzabar Config Editor")}`);
  console.log(`  ${RULE}`);

  printConfigSummary(cfg);

  // Main menu
  const menuOptions = [
    "Edit an environment",
    "Add new environment",
    "Remove an environment",
    "Edit Teamwork credentials",
    "Exit",
  ];

  const choice = await select("What would you like to do?", menuOptions);
  if (choice === -1 || choice === menuOptions.length - 1) {
    return { action: "edit", saved: false };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const close = () => rl.close();

  try {
    // ── Edit an environment ───────────────────────────────
    if (choice === 0) {
      const envs = cfg.environments ?? {};
      const envNames = Object.keys(envs);
      if (envNames.length === 0) {
        console.log(WARN("No environments to edit. Add one first."));
        close();
        return { action: "edit", saved: false };
      }

      const envIdx = await select("Select environment to edit:", envNames);
      if (envIdx === -1) { close(); return { action: "edit", saved: false }; }

      const envName = envNames[envIdx]!;
      const current = envs[envName] ?? {};

      console.log(`\n  ${HEADER(`Editing: ${envName}`)}`);
      console.log(`  ${DIM("Press Enter to keep current value.")}\n`);

      const newUrl  = await askField(rl, "Base URL ", current.url);
      const newUser = await askField(rl, "Username", current.user);
      const newPass = await askPassword(rl, !!current.password);

      const updatedEnv: Record<string, string> = {};
      if (newUrl)  updatedEnv.url = newUrl;
      if (newUser) updatedEnv.user = newUser;
      if (newPass) updatedEnv.password = btoa(newPass);
      else if (current.password) updatedEnv.password = current.password;

      writeConfigFile({ ...cfg, environments: { ...envs, [envName]: updatedEnv } });
      console.log(SUCCESS(`Saved configuration for '${envName}'.`));
      close();
      return { action: "edit", saved: true, env: envName };
    }

    // ── Add new environment ───────────────────────────────
    if (choice === 1) {
      console.log(`\n  ${HEADER("Add New Environment")}\n`);

      const name = await askField(rl, "Environment name (e.g. nsm-staging)");
      if (!name) {
        console.log(WARN("Name cannot be empty."));
        close();
        return { action: "edit", saved: false };
      }

      const url  = await askField(rl, "Base URL ");
      const user = await askField(rl, "Username");
      const pass = await askPassword(rl, false);

      const envs = cfg.environments ?? {};
      const entry: Record<string, string> = {};
      if (url)  entry.url = url;
      if (user) entry.user = user;
      if (pass) entry.password = btoa(pass);

      writeConfigFile({ ...cfg, environments: { ...envs, [name]: entry } });
      console.log(SUCCESS(`Added environment '${name}'.`));
      close();
      return { action: "edit", saved: true, env: name };
    }

    // ── Remove an environment ─────────────────────────────
    if (choice === 2) {
      const envs = cfg.environments ?? {};
      const envNames = Object.keys(envs);
      if (envNames.length === 0) {
        console.log(WARN("No environments to remove."));
        close();
        return { action: "edit", saved: false };
      }

      const envIdx = await select("Select environment to remove:", envNames);
      if (envIdx === -1) { close(); return { action: "edit", saved: false }; }

      const envName = envNames[envIdx]!;
      const yes = await confirmAction(rl, `Remove '${chalk.red(envName)}'?`);
      if (!yes) {
        console.log(DIM("  Cancelled."));
        close();
        return { action: "edit", saved: false };
      }

      const updated = { ...cfg, environments: { ...envs } };
      delete updated.environments![envName];
      writeConfigFile(updated);
      console.log(SUCCESS(`Removed environment '${envName}'.`));
      close();
      return { action: "edit", saved: true, env: envName };
    }

    // ── Edit Teamwork credentials ─────────────────────────
    if (choice === 3) {
      const tw = (cfg as any).teamwork ?? {};

      console.log(`\n  ${HEADER("Teamwork Credentials")}`);
      console.log(`  ${DIM("Press Enter to keep current value.")}\n`);

      const email = await askField(rl, "Email   ", tw.email);
      const passRaw = await askPassword(rl, !!tw.password);

      const teamwork: Record<string, string> = {};
      if (email) teamwork.email = email;
      if (passRaw) teamwork.password = btoa(passRaw);
      else if (tw.password) teamwork.password = tw.password;

      writeConfigFile({ ...cfg, teamwork } as BelzConfigFile);
      console.log(SUCCESS("Saved Teamwork credentials."));
      close();
      return { action: "edit", saved: true };
    }

    close();
    return { action: "edit", saved: false };

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
    }
  },
};

export default command;
