// core/config: schema validation, secrets (D5), atomic 0600 writes, default
// env (D6), and the cwd-.env guard (CORE-28).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "fs";
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
  hardenBelzHome,
  withoutDotenvInjected,
  writeConfigFile,
  writeSecureJson,
} from "../src/config";
import { CliError } from "../src/command";
import { getSourceDir } from "../src/belz-meta";
import { withTempEnvConfig, type TempEnvConfig } from "../src/testing/env-config";
import { scratchDir } from "../src/testing/scratch";
import { spawnCli } from "../src/testing/spawn-cli";
import { errorCode as codeOf, thrownCliError as errOf } from "../src/testing/errors";

let cfg: TempEnvConfig | null = null;
const savedEnv = process.env.BELZ_ENV;
afterEach(() => {
  cfg?.restore();
  cfg = null;
  if (savedEnv === undefined) delete process.env.BELZ_ENV;
  else process.env.BELZ_ENV = savedEnv;
  reloadConfig();
});

/** Write a raw config.json inside a temp-config scope (so it gets restored). */
function rawConfig(value: unknown) {
  // A second call in the same test must not orphan the first temp config
  // (its restore would never run and the config leaks into later files).
  cfg?.restore();
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
    expect(() => Config.getAllEnvs()).not.toThrow();
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
    rawConfig({ otherTool: { enabled: true }, environments: { a: { url: "https://a.test", extra: 1 } } });
    const raw = loadConfigFileRaw();
    writeConfigFile({ ...raw, defaultEnv: "a" });
    const back = JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8"));
    expect(back.otherTool).toEqual({ enabled: true });
    expect(back.environments.a.extra).toBe(1);
    expect(back.defaultEnv).toBe("a");
  });

  test("the real-world shape (base64 passwords, project, belz, jenkins, teamwork) validates unchanged", () => {
    rawConfig({
      environments: {
        dev: { url: "https://dev.test", user: "u", password: btoa("p") },
        "acme-demo": { url: "https://acme.test", user: "u", password: btoa("p"), project: "ACME" },
      },
      teamwork: { baseUrl: "https://tw.example.test/", email: "a@b.c", password: btoa("tw") },
      belz: { sourceDir: "/s", installDir: "/i", repoUrl: "r", version: "v", installedAt: "t" },
      jenkins: { baseUrl: "https://j.test/", user: "j", password: btoa("jp"), migrationJob: "a/b", profileEnvs: { DevAcme: "acme-dev" } },
    });
    expect(Config.configError).toBeNull();
    expect(Config.getAllEnvs()["acme-demo"]!.project).toBe("ACME");
    Config.setActiveEnv("dev");
    expect(Config.password).toBe("p");
    expect(Config.getJenkins()).toEqual({
      baseUrl: "https://j.test", user: "j", password: "jp", migrationJob: "a/b", profileEnvs: { devacme: "acme-dev" },
    });
    expect(Config.getTeamwork()).toEqual({ baseUrl: "https://tw.example.test", email: "a@b.c", password: "tw" });
  });

  test("an old config with the removed extension/dashboard sections still loads (they are ignored)", () => {
    rawConfig({
      environments: { "t-dev": { url: "https://t.test", user: "u", password: btoa("p") } },
      extension: { loadedBrowsers: "chrome" }, // even a shape the old schema rejected
      web: { autostartEnabled: true },
    });
    expect(Config.configError).toBeNull();
    Config.setActiveEnv("t-dev");
    expect(Config.cleanBaseUrl).toBe("https://t.test");
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

describe("permission repair (CORE-R5)", () => {
  function looseHome(): string {
    const home = join(scratchDir("perm-"), "belz");
    mkdirSync(join(home, "sessions"), { recursive: true });
    mkdirSync(join(home, "cache", "definitions", "t-dev"), { recursive: true });
    writeFileSync(join(home, "config.json"), "{}");
    writeFileSync(join(home, "sessions", "t-dev.json"), "{}");
    writeFileSync(join(home, "sessions", "t-qa.json"), "{}");
    for (const d of [home, join(home, "sessions"), join(home, "cache")]) chmodSync(d, 0o755);
    for (const f of ["config.json", "sessions/t-dev.json", "sessions/t-qa.json"]) chmodSync(join(home, f), 0o644);
    return home;
  }
  const mode = (p: string) => statSync(p).mode & 0o777;

  test("hardenBelzHome tightens the home, sessions, cache and config.json; idempotent", () => {
    const home = looseHome();
    const changed = hardenBelzHome(home);
    expect(changed.length).toBe(6);
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, "sessions"))).toBe(0o700);
    expect(mode(join(home, "cache"))).toBe(0o700);
    expect(mode(join(home, "config.json"))).toBe(0o600);
    expect(mode(join(home, "sessions", "t-dev.json"))).toBe(0o600);
    expect(mode(join(home, "sessions", "t-qa.json"))).toBe(0o600);
    expect(hardenBelzHome(home)).toEqual([]);
    expect(hardenBelzHome(join(home, "missing"))).toEqual([]); // never throws
  });

  test("a spawned belz repairs an old install's loose permissions on startup", async () => {
    const home = looseHome();
    const r = await spawnCli(["envs", "--llm"], { env: { BELZ_HOME: home }, timeoutMs: 30_000 });
    expect((r.envelope as any)?.ok).toBe(true);
    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, "sessions", "t-dev.json"))).toBe(0o600);
  }, 30_000);
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

  test("withEnv switches for the callback and restores a defaulted env as defaulted", async () => {
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" }, "t-b": { url: "https://b.test" } }, defaultEnv: "t-b" });
    const seen = await Config.withEnv("t-a", () => Config.activeEnv.name);
    expect(seen).toBe("t-a");
    expect(Config.activeEnv.name).toBe("t-b");
    expect(Config.envWasExplicit).toBe(false);
    await expect(Config.withEnv("t-a", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(Config.activeEnv.name).toBe("t-b");
    Config.setActiveEnv("t-a");
    const restore = Config.captureActiveEnv();
    Config.setActiveEnv("t-b");
    restore();
    expect(Config.activeEnv.name).toBe("t-a");
    expect(Config.envSource).toBe("flag");
  });

  test("BELZ_ENV beats config defaultEnv", () => {
    process.env.BELZ_ENV = "t-a";
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" }, "t-b": { url: "https://b.test" } }, defaultEnv: "t-b" });
    expect(Config.activeEnv.name).toBe("t-a");
    expect(Config.envSource).toBe("BELZ_ENV");
  });

  test("no built-in env: several envs without a default → nothing active, ENV_NOT_SELECTED on use", () => {
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" }, "t-b": { url: "https://b.test" } } });
    expect(Config.envSource).toBe("none");
    expect(Config.activeEnv.name).toBe("");
    const e = errOf(() => Config.cleanBaseUrl);
    expect(e.code).toBe("ENV_NOT_SELECTED");
    expect(e.message).toContain("t-a, t-b");
    expect(e.details).toEqual({ available: ["t-a", "t-b"] });
    Config.setActiveEnv("t-b");
    expect(Config.cleanBaseUrl).toBe("https://b.test");
  });

  test("the only configured env is the default without defaultEnv", () => {
    cfg = withTempEnvConfig({ envs: { solo: { url: "https://solo.test" } } });
    expect(Config.envSource).toBe("only");
    expect(Config.defaultEnvName).toBe("solo");
    expect(Config.cleanBaseUrl).toBe("https://solo.test");
    expect(Config.envWasExplicit).toBe(false);
  });

  test("an unknown default env fails on use with INVALID_ENV (never silently another env)", () => {
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" } }, defaultEnv: "t-typo" });
    expect(Config.activeEnv.name).toBe("t-typo");
    const e = errOf(() => Config.cleanBaseUrl);
    expect(e.code).toBe("INVALID_ENV");
    expect(e.message).toContain("defaultEnv");
  });

  test("setActiveEnv with an unknown name throws INVALID_ENV", () => {
    expect(codeOf(() => Config.setActiveEnv("nope-nope"))).toBe("INVALID_ENV");
  });

  test("CORE-R6: Object.prototype names are unknown envs, not crashes", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(codeOf(() => Config.setActiveEnv(name))).toBe("INVALID_ENV");
    }
    expect(Config.getAllEnvs()["constructor"]).toBeUndefined();
  });

  test("CORE-R6: a prototype-named default env fails with INVALID_ENV on use", () => {
    cfg = withTempEnvConfig({ envs: { "t-a": { url: "https://a.test" } }, defaultEnv: "constructor" });
    expect(errOf(() => Config.cleanBaseUrl).code).toBe("INVALID_ENV");
  });
});

describe("dotenv guard (CORE-28)", () => {
  test("trustedBelzEnv: BELZ_* only; values injected from a cwd .env are ignored", () => {
    const dir = scratchDir("dotenv-");
    writeFileSync(join(dir, ".env"), "BELZ_ENV=orb-qa\nBELZ_JENKINS_URL='https://evil.test'\nNSM_QA_URL=https://x\n");
    const env = {
      BELZ_ENV: "orb-qa", // same as .env → injected
      BELZ_JENKINS_URL: "https://evil.test", // same (quotes stripped) → injected
      BELZ_HTTP_TIMEOUT_MS: "5000", // not in .env → trusted
      ORB_QA_URL: "https://x", // not BELZ_* → never read
    };
    expect(trustedBelzEnv(env, dir)).toEqual({ BELZ_HTTP_TIMEOUT_MS: "5000" });
    // an explicitly exported value that differs from the file wins
    expect(trustedBelzEnv({ BELZ_ENV: "acme-dev" }, dir)).toEqual({ BELZ_ENV: "acme-dev" });
  });

  test("CORE-R14: withoutDotenvInjected drops any cwd-.env value (not just BELZ_*), reports the keys", () => {
    const dir = scratchDir("dotenv-any-");
    writeFileSync(join(dir, ".env"), "ORB_DEV_PASSWORD=evil\nBELZ_SRC_DIR=/tmp/evil\n");
    const r = withoutDotenvInjected({ ORB_DEV_PASSWORD: "evil", BELZ_SRC_DIR: "/tmp/evil", ORB_QA_USER: "me" }, dir);
    expect(r.values).toEqual({ ORB_QA_USER: "me" });
    expect(r.dropped).toEqual(["BELZ_SRC_DIR", "ORB_DEV_PASSWORD"]);
  });

  test("CORE-R14: a cwd .env BELZ_SRC_DIR does not pick the source dir for `belz update`", () => {
    const dir = scratchDir("dotenv-src-");
    writeFileSync(join(dir, ".env"), "BELZ_SRC_DIR=/tmp/evil-src\n");
    const saved = process.env.BELZ_SRC_DIR;
    const cwd = process.cwd();
    process.env.BELZ_SRC_DIR = "/tmp/evil-src";
    process.chdir(dir);
    try {
      cfg = withTempEnvConfig({ envs: {} });
      expect(getSourceDir()).not.toBe("/tmp/evil-src");
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env.BELZ_SRC_DIR;
      else process.env.BELZ_SRC_DIR = saved;
    }
  });

  test("a .env in cwd does not change `belz envs` (spawned CLI)", async () => {
    const home = scratchDir("dotenv-home-");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        environments: {
          "t-real": { url: "https://real.test", user: "u", password: btoa("p") },
          "t-other": { url: "https://other.test", user: "u", password: btoa("p") },
        },
      }),
    );
    const cwd = scratchDir("dotenv-cwd-");
    writeFileSync(
      join(cwd, ".env"),
      [
        "BELZ_ENV_T_OTHER_URL=https://dotenv-injected.invalid",
        "BELZ_ENV=t-real",
        `BELZ_HOME=${join(cwd, "evil-home")}`,
        "API_USER=evil",
      ].join("\n"),
    );
    const r = await spawnCli(["envs", "--llm"], { cwd, env: { BELZ_HOME: home }, timeoutMs: 30_000 });
    const env = r.envelope as any;
    expect(env?.ok).toBe(true);
    const byName = Object.fromEntries(env.data.envs.map((e: any) => [e.name, e]));
    expect(byName["t-other"].baseUrl).toBe("https://other.test");
    expect(byName["t-real"].baseUrl).toBe("https://real.test");
    // the .env's BELZ_ENV is ignored: two envs, no default → none active
    expect(env.data.active).toBeNull();
  }, 30_000);
});

test("BELZ_CONFIG_DIR is the test's throwaway home", () => {
  expect(BELZ_CONFIG_DIR).toBe(process.env.BELZ_HOME!);
});
