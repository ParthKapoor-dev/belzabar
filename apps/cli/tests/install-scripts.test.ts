// The installers decide "first run" before record-install creates
// config.json, and record-install writes it atomically with mode 0600.
// The installers themselves are never run here (they compile and install);
// record-install.mjs runs against a scratch HOME.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { scratchDir } from "@belzabar/core/testing";

const SCRIPTS = resolve(import.meta.dir, "../scripts");

function recordInstall(home: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, join(SCRIPTS, "record-install.mjs"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("record-install.mjs", () => {
  test("creates ~/.belz/config.json 0600 in a 0700 dir, no temp files left", () => {
    const home = scratchDir("ri-home-");
    const r = recordInstall(home, "/src", "/bin", "git@x:y.git", "abc1234");
    expect(r.exitCode).toBe(0);
    const cfg = join(home, ".belz", "config.json");
    expect(statSync(cfg).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".belz")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(cfg, "utf8")).belz).toMatchObject({ sourceDir: "/src", installDir: "/bin", version: "abc1234" });
    expect(readdirSync(join(home, ".belz"))).toEqual(["config.json"]);
  });

  test("keeps other sections; refuses to overwrite a malformed config", () => {
    const home = scratchDir("ri-keep-");
    mkdirSync(join(home, ".belz"));
    const cfg = join(home, ".belz", "config.json");
    writeFileSync(cfg, JSON.stringify({ environments: { "t-a": { url: "https://a.test" } } }), { mode: 0o644 });
    expect(recordInstall(home, "/src", "/bin", "", "v").exitCode).toBe(0);
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.environments["t-a"].url).toBe("https://a.test");
    expect(statSync(cfg).mode & 0o777).toBe(0o600);

    writeFileSync(cfg, "{ not json");
    expect(recordInstall(home, "/src", "/bin", "", "v").exitCode).not.toBe(0);
    expect(readFileSync(cfg, "utf8")).toBe("{ not json");
  });
});

describe("install scripts decide first run before recording", () => {
  test("install.sh", () => {
    const sh = readFileSync(join(SCRIPTS, "install.sh"), "utf8");
    const firstRun = sh.indexOf("FIRST_RUN=1");
    const record = sh.indexOf("record-install.mjs\" \\");
    const step8 = sh.indexOf('if [[ "$FIRST_RUN" == 1 ]]');
    expect(firstRun).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(firstRun);
    expect(step8).toBeGreaterThan(record);
    expect(sh).not.toContain('if [[ ! -f "$BELZ_CONFIG_DIR/config.json" ]]');
  });

  test("install.sh: first-run detection in a scratch HOME", () => {
    // Run just the detection snippet the installer uses, before and after record-install.
    const sh = readFileSync(join(SCRIPTS, "install.sh"), "utf8");
    const snippet = sh.match(/FIRST_RUN=0\n.*FIRST_RUN=1\n/)![0];
    const home = scratchDir("ri-first-");
    const detect = () =>
      Bun.spawnSync(["bash", "-c", `BELZ_CONFIG_DIR="$HOME/.belz"\n${snippet}echo $FIRST_RUN`], {
        env: { PATH: process.env.PATH ?? "", HOME: home },
        stdout: "pipe",
      }).stdout.toString().trim();
    expect(detect()).toBe("1");
    recordInstall(home, "/src", "/bin", "", "v");
    expect(detect()).toBe("0");
  });

  test("install.ps1", () => {
    const ps = readFileSync(join(SCRIPTS, "install.ps1"), "utf8");
    const firstRun = ps.indexOf("$FirstRun = ");
    const record = ps.indexOf('bun (Join-Path $ScriptDir "record-install.mjs")');
    expect(firstRun).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(firstRun);
    expect(ps).toContain("if ($FirstRun) {");
  });
});
