// `belz setup` merges instead of replacing (CORE-15) and stores explicit
// password encodings (D5, CORE-11); `belz config token` re-logs in when the
// JWT has expired or --refresh is given (CORE-10).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { CONFIG_FILE_PATH, reloadConfig } from "@belzabar/core";
import { fakeFetch, runCommand, scratchDir, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import setup from "../commands/setup/index";
import config from "../commands/config/index";

let cfg: TempEnvConfig | null = null;
let ff: FakeFetch | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

function jwt(exp: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u", exp })}.c2lnbmF0dXJlc2ln`;
}

function envFile(lines: string[]): string {
  const p = join(scratchDir("setup-"), "creds.env");
  writeFileSync(p, lines.join("\n"));
  return p;
}

function seedExisting() {
  cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.test", user: "s", password: "sp" } } });
  const raw = JSON.parse(readFileSync(cfg.configPath, "utf8"));
  raw.belz = { sourceDir: "/src" };
  raw.defaultEnv = "dev";
  writeFileSync(cfg.configPath, JSON.stringify(raw));
  reloadConfig();
}

describe("belz setup (CORE-15, D5)", () => {
  test("--env-file merges into existing envs; encodings are explicit; file is 0600", async () => {
    seedExisting();
    const file = envFile([
      "BELZ_ENV_T_QA_URL=https://t-qa.test",
      "BELZ_ENV_T_QA_USER=tq",
      "BELZ_ENV_T_QA_PASSWORD=plain pass==",
      "BELZ_ENV_T_DEV_URL=https://t-dev.test",
      "BELZ_ENV_T_DEV_USER=nd",
      "BELZ_ENV_T_DEV_PASSWORD=bm90YmFzZTY0", // looks like base64 but is taken literally
      "NSM_DEV_USER=legacy", // old per-project keys are no longer read
      "BELZ_ENV_T_NOURL_USER=x", // an env without a URL is skipped
      "TEAMWORK_URL=https://tw.example.test",
      "TEAMWORK_EMAIL=me@x.test",
      "TEAMWORK_PASSWORD=tw pw",
      "BELZ_JENKINS_PASSWORD=jk",
    ]);
    const r = await runCommand(setup, ["--env-file", file]);
    expect(r.envelope?.ok).toBe(true);
    const written = JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8"));
    expect(Object.keys(written.environments).sort()).toEqual(["dev", "t-dev", "t-qa"]);
    expect(written.environments.dev.url).toBe("https://dev.test"); // kept
    expect(written.environments["t-qa"]).toMatchObject({ password: "plain pass==", passwordEncoding: "plain" });
    expect(written.environments["t-dev"]).toMatchObject({ password: "bm90YmFzZTY0", passwordEncoding: "plain" });
    expect(written.teamwork).toEqual({ baseUrl: "https://tw.example.test", email: "me@x.test", password: "tw pw", passwordEncoding: "plain" });
    expect(written.jenkins).toMatchObject({ password: "jk", passwordEncoding: "plain" });
    expect(written.belz).toEqual({ sourceDir: "/src" });
    expect(written.defaultEnv).toBe("dev");
    expect(statSync(CONFIG_FILE_PATH).mode & 0o777).toBe(0o600);
    expect((r.envelope!.data as any).configPath).toBe(CONFIG_FILE_PATH);
  });

  test("--replace without --force is refused; with --force it drops unlisted envs", async () => {
    seedExisting();
    const file = envFile(["BELZ_ENV_T_QA_URL=https://t-qa.test", "BELZ_ENV_T_QA_USER=u", "BELZ_ENV_T_QA_PASSWORD=p"]);
    const refused = await runCommand(setup, ["--env-file", file, "--replace"]);
    expect(refused.envelope?.error?.code).toBe("SETUP_REPLACE_NEEDS_FORCE");
    const r = await runCommand(setup, ["--env-file", file, "--replace", "--force"]);
    expect(r.envelope?.ok).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8")).environments)).toEqual(["t-qa"]);
  });
});

describe("belz config get (F16 class)", () => {
  test("never prints the token; reports presence and expiry", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test", token: jwt(exp) } } });
    const r = await runCommand(config, ["get"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(r.stdout).not.toContain(jwt(exp));
    expect(r.stdout).not.toContain("test-password");
    expect(r.envelope?.data).toMatchObject({ tokenPresent: true, tokenExpired: false, tokenExpiresAt: new Date(exp * 1000).toISOString() });
    expect((r.envelope?.data as any).token).toBeUndefined();
    const human = await runCommand(config, ["get"], { env: "t-dev", llm: false });
    expect(human.stdout + human.stderr).not.toContain(jwt(exp).slice(0, 40));
  });
});

describe("belz config token (CORE-10)", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 60;

  test("a valid cached JWT is returned without logging in", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test", token: jwt(future) } } });
    ff = fakeFetch([]).install();
    const r = await runCommand(config, ["token"], { env: "t-dev" });
    expect((r.envelope?.data as any)?.token).toBe(jwt(future));
    expect(ff.requests.length).toBe(0);
  });

  test("an expired JWT triggers a re-login", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test", token: jwt(past) } } });
    ff = fakeFetch({ "POST /do/login": { token: jwt(future) } }).install();
    const r = await runCommand(config, ["token"], { env: "t-dev" });
    expect((r.envelope?.data as any)?.token).toBe(jwt(future));
    expect(ff.calls("POST", "/do/login").length).toBe(1);
  });

  test("--refresh forces a login", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test", token: jwt(future) } } });
    ff = fakeFetch({ "POST /do/login": { token: "new-token" } }).install();
    const r = await runCommand(config, ["token", "--refresh"], { env: "t-dev" });
    expect((r.envelope?.data as any)?.token).toBe("new-token");
  });
});

describe("belz setup: dotenv handling (CORE-R14, CORE-R16)", () => {
  test("--env-file strips inline comments on unquoted values (core parseDotEnv)", async () => {
    seedExisting();
    const file = envFile([
      "BELZ_ENV_T_DEV_URL=https://t-dev.test",
      "BELZ_ENV_T_DEV_PASSWORD=abc # rotated",
      "BELZ_ENV_T_QA_URL=https://t-qa.test",
      'BELZ_ENV_T_QA_PASSWORD="keep # this"',
    ]);
    const r = await runCommand(setup, ["--env-file", file]);
    expect(r.envelope?.ok).toBe(true);
    const written = JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8"));
    expect(written.environments["t-dev"].password).toBe("abc");
    expect(written.environments["t-qa"].password).toBe("keep # this");
  });

  test("--from-env ignores values Bun auto-loaded from a cwd .env", async () => {
    seedExisting();
    const dir = scratchDir("setup-dotenv-");
    writeFileSync(join(dir, ".env"), "BELZ_ENV_T_OK_PASSWORD=evilpw\nBELZ_ENV_EVIL_URL=https://evil.test\n");
    const keys = ["BELZ_ENV_T_OK_PASSWORD", "BELZ_ENV_EVIL_URL", "BELZ_ENV_T_OK_URL", "BELZ_ENV_T_OK_USER"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const cwd = process.cwd();
    Object.assign(process.env, {
      BELZ_ENV_T_OK_PASSWORD: "evilpw", // same as .env → injected
      BELZ_ENV_EVIL_URL: "https://evil.test",
      BELZ_ENV_T_OK_URL: "https://ok.test", // exported, not in .env → trusted
      BELZ_ENV_T_OK_USER: "okuser",
    });
    process.chdir(dir);
    try {
      const r = await runCommand(setup, ["--from-env"]);
      expect(r.envelope?.ok).toBe(true);
      const written = JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8"));
      expect(written.environments["t-ok"]).toMatchObject({ url: "https://ok.test", user: "okuser" });
      expect(written.environments.evil).toBeUndefined();
      expect(written.environments["t-ok"].password).toBeUndefined();
      expect(String(r.envelope?.meta?.warnings)).toContain("BELZ_ENV_T_OK_PASSWORD");
    } finally {
      process.chdir(cwd);
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
