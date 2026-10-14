// wi-impl configuration: ~/.wi-impl/config.json (+ explicit WI_IMPL_* env vars).
//
//   config/schema.ts    zod schema, validated at load (CONFIG_INVALID with a path)
//   config/secrets.ts   decodeSecret/encodeSecret — explicit passwordEncoding
//   config/fs.ts        writeSecureJson — atomic tmp+rename, 0600
//   config/env-vars.ts  trustedBelzEnv — WI_IMPL_* only, cwd .env injection ignored;
//                       inAgentSession — WI_IMPL_AGENT / CLAUDECODE select --llm output
//
// Env selection: `--env` (runner → Config.setActiveEnv) > WI_IMPL_ENV >
// config.json `defaultEnv` > the only configured env. There is no built-in env:
// with several envs and no default, env-aware commands fail with
// ENV_NOT_SELECTED. `Config.envSource` / `envWasExplicit` tell the runner
// whether the user named the env explicitly.

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { CliError } from "../command";
import type { Environment } from "../types";
import { hardenBelzHome, writeSecureJson } from "./fs";
import { decodeSecret } from "./secrets";
import { trustedBelzEnv } from "./env-vars";
import { validateConfigFile, envEntryProblem, type BelzConfigFile } from "./schema";

export * from "./schema";
export * from "./secrets";
export * from "./fs";
export { trustedBelzEnv, parseDotEnv, withoutDotenvInjected, withLegacyNames, inAgentSession } from "./env-vars";

/** The data directory before the rename; a compiled binary moves it to `~/.wi-impl` on first run. */
const LEGACY_CONFIG_DIR = join(homedir(), ".belz");

/**
 * Root of all wi-impl runtime data. `WI_IMPL_HOME` overrides `~/.wi-impl` (used by tests
 * so they never touch the real directory). While only the legacy `~/.wi-impl` exists (not yet
 * moved: a run from source never moves it), that is read instead. Read once at import time.
 */
export const BELZ_CONFIG_DIR = resolveConfigDir(trustedBelzEnv().WI_IMPL_HOME, join(homedir(), ".wi-impl"), LEGACY_CONFIG_DIR);

/** `override`, else `home`, else `legacy` while only that exists. Exported for tests. */
export function resolveConfigDir(override: string | undefined, home: string, legacy: string): string {
  if (override) return override;
  return !existsSync(home) && existsSync(legacy) ? legacy : home;
}

export const CONFIG_FILE_PATH = join(BELZ_CONFIG_DIR, "config.json");

/** Active-env name used when nothing selects an env (see `ENV_NOT_SELECTED`). */
export const NO_ENV = "";

interface JenkinsConfig {
  baseUrl: string;
  user: string;
  password: string;
  migrationJob: string;
  /** Migration profile segment (lowercase) → wi-impl env name; {} when not configured. */
  profileEnvs: Record<string, string>;
}

interface TeamworkCredentials {
  /** Site root without a trailing slash; "" when not configured. */
  baseUrl: string;
  email: string;
  password: string;
}

/**
 * Where the active env came from. "flag" = chosen explicitly (--env / setActiveEnv),
 * "only" = the single configured env, "none" = nothing selected an env.
 */
type EnvSource = "flag" | "WI_IMPL_ENV" | "config" | "only" | "none";

interface LoadedConfig {
  /** Parsed JSON as-is (for read-modify-write by setup / config edit). */
  raw: BelzConfigFile;
  /** Validated config ({} when invalid). */
  config: BelzConfigFile;
  /** File-level problem (malformed JSON, schema violation). */
  error: CliError | null;
}

function loadConfig(): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(CONFIG_FILE_PATH, "utf-8");
  } catch {
    return { raw: {}, config: {}, error: null }; // no config yet
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      raw: {},
      config: {},
      error: new CliError(`Invalid config ${CONFIG_FILE_PATH}: not valid JSON (${(e as Error).message}).`, {
        code: "CONFIG_INVALID",
        details: { file: CONFIG_FILE_PATH },
      }),
    };
  }
  const { config, error } = validateConfigFile(raw, CONFIG_FILE_PATH);
  const rawObj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as BelzConfigFile) : {};
  return { raw: rawObj, config, error };
}

/** The config file exactly as stored (not validated). Missing/unreadable → {}. */
export function loadConfigFileRaw(): BelzConfigFile {
  return structuredClone(loadConfig().raw);
}

/** Atomically write config.json (0600). */
export function writeConfigFile(config: BelzConfigFile): void {
  writeSecureJson(CONFIG_FILE_PATH, config, { pretty: true });
}

/** Derive a project label from an env name (`acme-qa` → "ACME"). */
function deriveProject(name: string): string {
  const prefix = name.split(/[-_]/)[0] ?? name;
  return prefix.toUpperCase();
}

/** Own-property lookup: env names come from argv, so `constructor` / `__proto__` must not hit Object.prototype. */
function ownEntry<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

function buildEnvironments(config: BelzConfigFile): Record<string, Environment> {
  const fileEnvs = config.environments ?? {};
  // Null prototype: `environments[name]` is safe for any user-supplied name.
  const environments: Record<string, Environment> = Object.create(null);
  for (const name of Object.keys(fileEnvs)) {
    const entry = ownEntry(fileEnvs, name);
    const problem = envEntryProblem(entry);
    environments[name] = {
      name,
      project: entry?.project ?? deriveProject(name),
      baseUrl: (entry?.url ?? "").replace(/\/+$/, ""),
      credentials: {
        loginId: entry?.user ?? "",
        password: entry?.password ?? "",
        ...(entry?.passwordEncoding ? { passwordEncoding: entry.passwordEncoding } : {}),
      },
      ...(problem ? { problem } : {}),
    };
  }
  return environments;
}

// Repair loose permissions left by older installs before anything is read.
hardenBelzHome(BELZ_CONFIG_DIR);

let loaded = loadConfig();
let trusted = trustedBelzEnv();
let environments = buildEnvironments(loaded.config);

function resolveDefault(): { name: string; source: EnvSource } {
  if (trusted.WI_IMPL_ENV) return { name: trusted.WI_IMPL_ENV, source: "WI_IMPL_ENV" };
  if (loaded.config.defaultEnv) return { name: loaded.config.defaultEnv, source: "config" };
  const names = Object.keys(environments);
  if (names.length === 1) return { name: names[0]!, source: "only" };
  return { name: NO_ENV, source: "none" };
}

let defaultEnv = resolveDefault();
let activeEnvName = defaultEnv.name;
let envSource: EnvSource = defaultEnv.source;

/**
 * Re-read `config.json` and the env vars, and rebuild the environment table.
 * Config is otherwise loaded once at import time; this exists for tests
 * (core/testing `withTempEnvConfig`) that write a throwaway config. The active
 * env is kept when it was chosen explicitly and still exists, else reset to the default.
 */
export function reloadConfig(): void {
  loaded = loadConfig();
  trusted = trustedBelzEnv();
  environments = buildEnvironments(loaded.config);
  defaultEnv = resolveDefault();
  if (envSource !== "flag" || !environments[activeEnvName]) {
    activeEnvName = defaultEnv.name;
    envSource = defaultEnv.source;
  }
}

/** ENV_NOT_SELECTED: no --env, no WI_IMPL_ENV, no `defaultEnv`, and not exactly one configured env. */
export function noEnvSelectedError(): CliError {
  const names = Object.keys(environments);
  const message = names.length === 0
    ? `No environments configured. Add one with 'wi-impl config' (or 'wi-impl setup'), then pass --env <name>.`
    : `No environment selected. Pass --env <name>, set WI_IMPL_ENV, or set "defaultEnv" in ${CONFIG_FILE_PATH}. ` +
      `Configured: ${names.join(", ")}`;
  return new CliError(message, { code: "ENV_NOT_SELECTED", details: { available: names } });
}

function unknownEnvError(name: string, source: EnvSource): CliError {
  const where =
    source === "WI_IMPL_ENV" ? " (from WI_IMPL_ENV)" : source === "config" ? ` (from "defaultEnv" in ${CONFIG_FILE_PATH})` : "";
  return new CliError(
    `Unknown environment: ${name}${where}. Available: ${Object.keys(environments).join(", ")}`,
    { code: "INVALID_ENV", details: { env: name, source } },
  );
}

/** The active env, throwing the coded error if it is unusable (bad file, unknown default, no url). */
function usableEnv(): Environment {
  if (loaded.error) throw loaded.error;
  if (envSource === "none") throw noEnvSelectedError();
  const env = environments[activeEnvName];
  if (!env) throw unknownEnvError(activeEnvName, envSource);
  if (env.problem) {
    throw new CliError(`Invalid config: environment '${env.name}' ${env.problem}. Fix it with 'wi-impl config edit'.`, {
      code: "CONFIG_INVALID",
      details: { path: `environments.${env.name}.url`, env: env.name },
    });
  }
  return env;
}

export const Config = {
  /**
   * Select the active env. Marks the selection explicit (`envSource: "flag"`).
   * Throws INVALID_ENV for an unknown name.
   */
  setActiveEnv(name: string): void {
    if (!environments[name]) {
      throw new CliError(`Unknown environment: ${name}. Available: ${Object.keys(environments).join(", ")}`, {
        code: "INVALID_ENV",
        details: { env: name },
      });
    }
    activeEnvName = name;
    envSource = "flag";
  },

  /** Drop an explicit selection: back to the default env (WI_IMPL_ENV > defaultEnv > the only env, else none). */
  resetActiveEnv(): void {
    activeEnvName = defaultEnv.name;
    envSource = defaultEnv.source;
  },

  /**
   * Snapshot the current env selection; the returned function restores it
   * exactly (the same name and the same explicit/defaulted source). For code
   * that switches env several times and must leave the caller's env intact.
   */
  captureActiveEnv(): () => void {
    const name = activeEnvName;
    const source = envSource;
    return () => {
      activeEnvName = name;
      envSource = source;
    };
  },

  /**
   * Run `fn` with `name` as the active env (INVALID_ENV if unknown), then
   * restore the caller's selection even when `fn` throws. The env is process
   * global, so calls must not run concurrently.
   */
  async withEnv<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const restore = Config.captureActiveEnv();
    Config.setActiveEnv(name);
    try {
      return await fn();
    } finally {
      restore();
    }
  },

  /**
   * The active env. Never throws: an unknown or missing default env yields a placeholder
   * (empty url; name `NO_ENV` when none is selected) — the coded error surfaces on
   * first use (baseUrl / credentials / assertUsable).
   */
  get activeEnv(): Environment {
    return (
      environments[activeEnvName] ?? {
        name: activeEnvName,
        project: activeEnvName === NO_ENV ? "" : deriveProject(activeEnvName),
        baseUrl: "",
        credentials: { loginId: "", password: "" },
        problem: "is not configured",
      }
    );
  },

  /** Name of the env used when no `--env` is given: WI_IMPL_ENV > config `defaultEnv` > the only env > `NO_ENV`. */
  get defaultEnvName(): string {
    return defaultEnv.name;
  },

  /** Where the active env came from. */
  get envSource(): EnvSource {
    return envSource;
  },

  /** True when the active env was chosen explicitly (`--env`), not defaulted (writes require this). */
  get envWasExplicit(): boolean {
    return envSource === "flag";
  },

  /** File-level config problem (malformed JSON / schema), or null. */
  get configError(): CliError | null {
    return loaded.error;
  },

  /** Throw the coded error (CONFIG_INVALID / INVALID_ENV) if the active env cannot be used. */
  assertUsable(): Environment {
    return usableEnv();
  },

  getAllEnvs: () => environments,

  get baseUrl() {
    return usableEnv().baseUrl;
  },
  get cleanBaseUrl() {
    return usableEnv().baseUrl.replace(/\/$/, "");
  },
  get loginId() {
    return usableEnv().credentials.loginId;
  },
  /** Decoded password of the active env ("" when unset). Throws CONFIG_INVALID for a bad encoding. */
  get password() {
    const env = usableEnv();
    return decodeSecret(env.credentials.password, env.credentials.passwordEncoding, `environments.${env.name}.password`);
  },

  getJenkins(): JenkinsConfig {
    if (loaded.error) throw loaded.error;
    const file = loaded.config.jenkins ?? {};
    const filePassword = decodeSecret(file.password, file.passwordEncoding, "jenkins.password");
    return {
      baseUrl: (file.baseUrl ?? trusted.WI_IMPL_JENKINS_URL ?? "").replace(/\/$/, ""),
      user: file.user ?? trusted.WI_IMPL_JENKINS_USER ?? "",
      password: filePassword || trusted.WI_IMPL_JENKINS_PASSWORD || "",
      migrationJob: file.migrationJob ?? trusted.WI_IMPL_JENKINS_JOB ?? "",
      profileEnvs: Object.fromEntries(
        Object.entries(file.profileEnvs ?? {}).map(([segment, env]) => [segment.toLowerCase(), env]),
      ),
    };
  },

  /** Teamwork site + credentials: config `teamwork` section, else WI_IMPL_TEAMWORK_URL / _EMAIL / _PASSWORD (plain). */
  getTeamwork(): TeamworkCredentials {
    if (loaded.error) throw loaded.error;
    const tw = loaded.config.teamwork ?? {};
    const password = tw.password
      ? decodeSecret(tw.password, tw.passwordEncoding, "teamwork.password")
      : trusted.WI_IMPL_TEAMWORK_PASSWORD ?? "";
    return {
      baseUrl: (tw.baseUrl ?? trusted.WI_IMPL_TEAMWORK_URL ?? "").replace(/\/+$/, ""),
      email: tw.email ?? trusted.WI_IMPL_TEAMWORK_EMAIL ?? "",
      password,
    };
  },
};
