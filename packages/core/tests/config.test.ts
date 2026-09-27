// core/config: schema validation, secrets (D5), atomic 0600 writes, default
// env (D6), and the cwd-.env guard (CORE-28).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  BELZ_CONFIG_DIR,
  CONFIG_FILE_PATH,
  Config,
  decodeSecret,
  encodeSecret,
  keepSecret,
  loadConfigFileRaw,
  reloadConfig,
  trustedBelzEnv,
  writeConfigFile,
  writeSecureJson,
} from "../src/config";
import { CliError } from "../src/command";
import { withTempEnvConfig, type TempEnvConfig } from "../src/testing/env-config";
import { scratchDir } from "../src/testing/scratch";
import { spawnCli } from "../src/testing/spawn-cli";

let cfg: TempEnvConfig | null = null;
const savedEnv = process.env.BELZ_ENV;
afterEach(() => {
  cfg?.restore();
  cfg = null;
  if (savedEnv === undefined) delete process.env.BELZ_ENV;
  else process.env.BELZ_ENV = savedEnv;
  reloadConfig();
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as CliError).code;
  }
  return "(no error)";
}

function errOf(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected throw");
}

/** Write a raw config.json inside a temp-config scope (so it gets restored). */
function rawConfig(value: unknown) {
  cfg = withTempEnvConfig({ envs: {} });
  writeFileSync(cfg.configPath, typeof value === "string" ? value : JSON.stringify(value));
  reloadConfig();
}

describe("secrets (D5)", () => {
  test("plain, legacy base64 and explicit base64 decode; bad base64 is CONFIG_INVALID with a path", () => {
    expect(decodeSecret("hunter2", "plain", "x.password")).toBe("hunter2");
    expect(decodeSecret(btoa("hunter2"), undefined, "x.password")).toBe("hunter2");
    expect(decodeSecret(btoa("hunter2"), "base64", "x.password")).toBe("hunter2");
    expect(decodeSecret("", undefined, "x")).toBe("");
    const e = errOf(() => decodeSecret("not base64!", undefined, "environments.a.password"));
    expect(e.code).toBe("CONFIG_INVALID");
    expect(e.message).toContain("environments.a.password");
  });

  test("encodeSecret stores plain + explicit encoding; keepSecret copies as-is", () => {
    expect(encodeSecret("p w")).toEqual({ password: "p w", passwordEncoding: "plain" });
    expect(keepSecret({ password: "cA==" })).toEqual({ password: "cA==" });
    expect(keepSecret({ password: "p", passwordEncoding: "plain" })).toEqual({ password: "p", passwordEncoding: "plain" });
    expect(keepSecret(undefined)).toEqual({});
  });

  test("Config.password honours passwordEncoding: plain", () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test", password: "Zz==plain", passwordEncoding: "plain" } }, activeEnv: "t-dev" });
    expect(Config.password).toBe("Zz==plain");
  });

  test("a non-base64 legacy password is CONFIG_INVALID, not UNHANDLED (CORE-11)", () => {
    rawConfig({ environments: { "t-dev": { url: "https://t.test", user: "u", password: "plain text!" } } });
    Config.setActiveEnv("t-dev");
    expect(codeOf(() => Config.password)).toBe("CONFIG_INVALID");
  });
});

describe("schema validation (CORE-18)", () => {
  test("a custom env without url → CONFIG_INVALID naming the env, only when used", () => {
    rawConfig({ environments: { "t-nourl": { user: "u" }, "t-ok": { url: "https://ok.test" } } });
    Config.setActiveEnv("t-ok");
    expect(Config.cleanBaseUrl).toBe("https://ok.test");
    Config.setActiveEnv("t-nourl");
    const e = errOf(() => Config.cleanBaseUrl);
    expect(e.code).toBe("CONFIG_INVALID");
    expect(e.message).toContain("t-nourl");
    expect(e.message).toContain("no url");
  });

  test("wrong types → CONFIG_INVALID with the path", () => {
    rawConfig({ environments: { "t-dev": { url: "https://t.test", password: 12 } } });
    expect(Config.configError?.code).toBe("CONFIG_INVALID");
    expect(Config.configError?.message).toContain("environments.t-dev.password");
    const e = errOf(() => Config.cleanBaseUrl);
    expect(e.code).toBe("CONFIG_INVALID");
    // listing envs still works (so `belz envs` / `belz config edit` can run)
    expect(Config.getAllEnvs()["nsm-dev"]).toBeDefined();
  });

  test("environments.<env>.sqlDefaultDb (AD-36): a string is accepted; a non-string is CONFIG_INVALID", () => {
    rawConfig({ environments: { "t-dev": { url: "https://t.test", sqlDefaultDb: "testing_db" } } });
    expect(Config.configError).toBeNull();
    expect(loadConfigFileRaw().environments?.["t-dev"]?.sqlDefaultDb).toBe("testing_db");
    rawConfig({ environments: { "t-dev": { url: "https://t.test", sqlDefaultDb: 5 } } });
    expect(Config.configError?.message).toContain("environments.t-dev.sqlDefaultDb");
  });

  test("malformed JSON → CONFIG_INVALID (was silently ignored)", () => {
    rawConfig("{ not json");
    expect(Config.configError?.code).toBe("CONFIG_INVALID");
  });

  test("unknown keys survive a read-modify-write", () => {
    rawConfig({ web: { autostartEnabled: true }, environments: { a: { url: "https://a.test", extra: 1 } } });
    const raw = loadConfigFileRaw();
    writeConfigFile({ ...raw, defaultEnv: "a" });
    const back = JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8"));
    expect(back.web).toEqual({ autostartEnabled: true });
    expect(back.environments.a.extra).toBe(1);
    expect(back.defaultEnv).toBe("a");
  });

  test("the real-world shape (base64 passwords, project, belz, web, jenkins, teamwork) validates unchanged", () => {
    rawConfig({
      environments: {
        "nsm-dev": { url: "https://nsm-dev.test", user: "u", password: btoa("p") },
        "edi-demo": { url: "https://edi.test", user: "u", password: btoa("p"), project: "EDI" },
      },
      teamwork: { email: "a@b.c", password: btoa("tw") },
      belz: { sourceDir: "/s", installDir: "/i", repoUrl: "r", version: "v", installedAt: "t" },
      web: { autostartEnabled: false },
      jenkins: { baseUrl: "https://j.test/", user: "j", password: btoa("jp"), migrationJob: "a/b" },
    });
    expect(Config.configError).toBeNull();
    expect(Config.getAllEnvs()["edi-demo"]!.project).toBe("EDI");
    Config.setActiveEnv("nsm-dev");
    expect(Config.password).toBe("p");
    expect(Config.getJenkins()).toEqual({ baseUrl: "https://j.test", user: "j", password: "jp", migrationJob: "a/b" });
    expect(Config.getTeamwork()).toEqual({ email: "a@b.c", password: "tw" });
  });
});

describe("atomic 0600 writes (CORE-12)", () => {
  test("writeConfigFile and writeSecureJson write 0600 and leave no temp files", () => {
    cfg = withTempEnvConfig({ envs: {} });
    writeConfigFile({ environments: {} });
    expect(statSync(CONFIG_FILE_PATH).mode & 0o777).toBe(0o600);
    const dir = scratchDir("secure-");
    const p = join(dir, "sub", "s.json");
    writeSecureJson(p, { a: 1 });
    writeSecureJson(p, { a: 2 });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ a: 2 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "sub"))).toEqual(["s.json"]);
  });
});

describe("default env (D6 / CORE-26)", () => {
  test("config defaultEnv is used when no --env; it is not explicit", () => {
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" }, "t-b": { url: "https://b.test" } }, defaultEnv: "t-b" });
    expect(Config.activeEnv.name).toBe("t-b");
    expect(Config.defaultEnvName).toBe("t-b");
    expect(Config.envSource).toBe("config");
    expect(Config.envWasExplicit).toBe(false);
    Config.setActiveEnv("t-a");
    expect(Config.envWasExplicit).toBe(true);
    expect(Config.envSource).toBe("flag");
  });

  test("BELZ_ENV beats config defaultEnv", () => {
    process.env.BELZ_ENV = "t-a";
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" }, "t-b": { url: "https://b.test" } }, defaultEnv: "t-b" });
    expect(Config.activeEnv.name).toBe("t-a");
    expect(Config.envSource).toBe("BELZ_ENV");
  });

  test("an unknown default env fails on use with INVALID_ENV (never silently nsm-dev)", () => {
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" } }, defaultEnv: "t-typo" });
    expect(Config.activeEnv.name).toBe("t-typo");
    const e = errOf(() => Config.cleanBaseUrl);
    expect(e.code).toBe("INVALID_ENV");
    expect(e.message).toContain("defaultEnv");
  });

  test("setActiveEnv with an unknown name throws INVALID_ENV", () => {
    expect(codeOf(() => Config.setActiveEnv("nope-nope"))).toBe("INVALID_ENV");
  });
});

describe("dotenv guard (CORE-28)", () => {
  test("trustedBelzEnv: BELZ_* only; values injected from a cwd .env are ignored", () => {
    const dir = scratchDir("dotenv-");
    writeFileSync(join(dir, ".env"), "BELZ_ENV=nsm-qa\nBELZ_JENKINS_URL='https://evil.test'\nNSM_QA_URL=https://x\n");
    const env = {
      BELZ_ENV: "nsm-qa", // same as .env → injected
      BELZ_JENKINS_URL: "https://evil.test", // same (quotes stripped) → injected
      BELZ_HTTP_TIMEOUT_MS: "5000", // not in .env → trusted
      NSM_QA_URL: "https://x", // not BELZ_* → never read
    };
    expect(trustedBelzEnv(env, dir)).toEqual({ BELZ_HTTP_TIMEOUT_MS: "5000" });
    // an explicitly exported value that differs from the file wins
    expect(trustedBelzEnv({ BELZ_ENV: "sems-dev" }, dir)).toEqual({ BELZ_ENV: "sems-dev" });
  });

  test("a .env in cwd does not change `belz envs` (spawned CLI)", async () => {
    const home = scratchDir("dotenv-home-");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ environments: { "t-real": { url: "https://real.test", user: "u", password: btoa("p") } } }),
    );
    const cwd = scratchDir("dotenv-cwd-");
    writeFileSync(
      join(cwd, ".env"),
      [
        "NSM_QA_URL=https://dotenv-injected.invalid",
        "BELZ_ENV=t-real",
        `BELZ_HOME=${join(cwd, "evil-home")}`,
        "API_USER=evil",
      ].join("\n"),
    );
    const r = await spawnCli(["envs", "--llm"], { cwd, env: { BELZ_HOME: home }, timeoutMs: 30_000 });
    const env = r.envelope as any;
    expect(env?.ok).toBe(true);
    const byName = Object.fromEntries(env.data.envs.map((e: any) => [e.name, e]));
    expect(byName["nsm-qa"].baseUrl).toBe("https://nsm-qa.nc.verifi.dev");
    expect(byName["t-real"].baseUrl).toBe("https://real.test");
    expect(env.data.active).toBe("nsm-dev");
  }, 30_000);
});

test("BELZ_CONFIG_DIR is the test's throwaway home", () => {
  expect(BELZ_CONFIG_DIR).toBe(process.env.BELZ_HOME!);
});
