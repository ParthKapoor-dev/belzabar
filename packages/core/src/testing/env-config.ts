// withTempEnvConfig: write a throwaway ~/.belz/config.json (+ session files)
// under BELZ_HOME and reload Config, so commands see fake environments.
//
//   const cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" });
//   ... apiFetch uses session token "test-token", no login ...
//   cfg.restore();
//
// Refuses to run unless BELZ_HOME points somewhere other than the real ~/.belz
// (the bun test preload sets it to a tmp dir).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { BELZ_CONFIG_DIR, Config, reloadConfig, type BelzConfigFile } from "../config";

export interface TempEnvSpec {
  url: string;
  user?: string;
  /** Plain-text password (base64-encoded into config.json for you). */
  password?: string;
  project?: string;
  /** Session token written to sessions/<env>.json. Default "test-token"; `null` = no session (forces login). */
  token?: string | null;
}

export interface TempEnvConfigOptions {
  envs: Record<string, TempEnvSpec>;
  teamwork?: BelzConfigFile["teamwork"];
  jenkins?: BelzConfigFile["jenkins"];
  /** Make this env active (Config.setActiveEnv). */
  activeEnv?: string;
}

export interface TempEnvConfig {
  home: string;
  configPath: string;
  sessionPath(env: string): string;
  restore(): void;
  [Symbol.dispose](): void;
}

export function assertSafeBelzHome(): string {
  const real = resolve(join(homedir(), ".belz"));
  if (!process.env.BELZ_HOME || resolve(BELZ_CONFIG_DIR) === real) {
    throw new Error(
      "core/testing: BELZ_HOME must point at a throwaway dir (is the bun test preload " +
        "packages/core/tests/preload-belz-home.ts wired in bunfig.toml?)"
    );
  }
  return BELZ_CONFIG_DIR;
}

export function withTempEnvConfig(options: TempEnvConfigOptions): TempEnvConfig {
  const home = assertSafeBelzHome();
  const configPath = join(home, "config.json");
  const sessionDir = join(home, "sessions");
  const sessionPath = (env: string) => join(sessionDir, `${env}.json`);

  const backups = new Map<string, string | null>();
  const backup = (p: string) => {
    if (!backups.has(p)) backups.set(p, existsSync(p) ? readFileSync(p, "utf8") : null);
  };

  const previousActive = Config.activeEnv?.name;

  backup(configPath);
  const config: BelzConfigFile = { environments: {} };
  for (const [name, spec] of Object.entries(options.envs)) {
    config.environments![name] = {
      url: spec.url,
      user: spec.user ?? "test-user",
      password: btoa(spec.password ?? "test-password"),
      ...(spec.project ? { project: spec.project } : {}),
    };
  }
  if (options.teamwork) config.teamwork = options.teamwork;
  if (options.jenkins) config.jenkins = options.jenkins;
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  mkdirSync(sessionDir, { recursive: true });
  for (const [name, spec] of Object.entries(options.envs)) {
    const p = sessionPath(name);
    backup(p);
    const token = spec.token === undefined ? "test-token" : spec.token;
    if (token === null) rmSync(p, { force: true });
    else writeFileSync(p, JSON.stringify({ token, refreshToken: "" }));
  }

  reloadConfig();
  if (options.activeEnv) Config.setActiveEnv(options.activeEnv);

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [p, content] of backups) {
      if (content === null) rmSync(p, { force: true });
      else writeFileSync(p, content);
    }
    reloadConfig();
    try {
      if (previousActive) Config.setActiveEnv(previousActive);
    } catch {
      /* env no longer exists: reloadConfig already fell back to nsm-dev */
    }
  };

  return { home, configPath, sessionPath, restore, [Symbol.dispose]: restore };
}
