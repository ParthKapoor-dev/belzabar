import { CliError, ok, Config, loadConfigFileRaw, loadSession, login, type CommandModule } from "@belzabar/core";

// ── Types ────────────────────────────────────────────────────────────────────

interface ConfigGetArgs {
  action: "get";
}

interface ConfigTokenArgs {
  action: "token";
}

type ConfigArgs = ConfigGetArgs | ConfigTokenArgs;

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

type ConfigData = ConfigGetData | ConfigTokenData;

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

    if (sub === "get") return { action: "get" };
    if (sub === "token") return { action: "token" };

    throw new CliError(`Unknown config subcommand: '${sub}'. Available: get, token, edit`, {
      code: "UNKNOWN_SUBCOMMAND",
    });
  },

  async execute(args) {
    const env = Config.activeEnv;
    const rawFile = loadConfigFileRaw();
    const fileEnv = rawFile.environments?.[env.name];

    if (args.action === "get") {
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

    throw new CliError("Unhandled config subcommand.", { code: "UNHANDLED_SUBCOMMAND" });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ConfigData;

    if (data.action === "get") {
      const d = data as ConfigGetData;
      const pwdLabel =
        d.passwordSource === "file"
          ? "configured (config file)"
          : d.passwordSource === "env"
          ? "configured (env var)"
          : "not set";
      const tokenLabel = d.token
        ? d.token.length > 60
          ? `${d.token.slice(0, 60)}...`
          : d.token
        : "(no cached session)";

      ui.text(`Config: ${d.env}`);
      ui.table(
        ["Field", "Value"],
        [
          ["URL", d.url],
          ["User", d.user],
          ["Password", pwdLabel],
          ["Token", tokenLabel],
        ]
      );
      return;
    }

    if (data.action === "token") {
      const d = data as ConfigTokenData;
      // Raw token output — just print it so it's easy to copy or pipe
      process.stdout.write(d.token + "\n");
    }
  },
};

export default command;
