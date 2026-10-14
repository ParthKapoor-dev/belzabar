// `belz update` never discards local work and installs to the recorded dir.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CONFIG_FILE_PATH, reloadConfig } from "@belzabar/core";
import { runCommand, scratchDir, withTempEnvConfig } from "@belzabar/core/testing";
import updateModule, { installerCommand, planUpdate, worktreeDirty } from "../commands/update/index";

// `update` is registered with envAware: false (apps/cli/bin/options.ts).
const update = { ...updateModule, envAware: false };

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("planUpdate", () => {
  const clean = { ahead: 0, behind: 0, dirty: false };
  test("--force only rebuilds; it never implies a reset", () => {
    expect(planUpdate(clean, { check: false, force: false }).action).toBe("up-to-date");
    expect(planUpdate(clean, { check: false, force: true }).action).toBe("rebuild");
    expect(planUpdate({ ...clean, dirty: true }, { check: false, force: true }).action).toBe("rebuild");
    expect(planUpdate(clean, { check: true, force: true }).action).toBe("up-to-date");
  });
  test("something to pull: dirty or ahead is refused even with --force; clean fast-forwards", () => {
    const behind = { ...clean, behind: 2 };
    for (const force of [false, true]) {
      expect(planUpdate({ ...behind, dirty: true }, { check: false, force })).toMatchObject({ action: "refuse", code: "DIRTY_TREE" });
      expect(planUpdate({ ...behind, ahead: 1 }, { check: false, force })).toMatchObject({ action: "refuse", code: "LOCAL_COMMITS" });
      expect(planUpdate(behind, { check: false, force }).action).toBe("fast-forward");
    }
    expect(planUpdate({ ...behind, dirty: true }, { check: true, force: false }).action).toBe("check-only");
  });
});

describe("worktreeDirty (NEW-4)", () => {
  test("untracked files do not count; tracked edits and staged changes do", () => {
    const dir = mkdtempSync(join(tmpdir(), "belz-update-dirty-"));
    try {
      const g = (...a: string[]) => spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
      g("init", "-q");
      writeFileSync(join(dir, "tracked.txt"), "a\n");
      g("add", "tracked.txt");
      g("commit", "-q", "-m", "init");
      expect(worktreeDirty(dir)).toBe(false);
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", "x.json"), "{}");
      writeFileSync(join(dir, "scratch.md"), "notes");
      expect(worktreeDirty(dir)).toBe(false);
      writeFileSync(join(dir, "tracked.txt"), "b\n");
      expect(worktreeDirty(dir)).toBe(true);
      g("checkout", "--", "tracked.txt");
      g("add", "scratch.md");
      expect(worktreeDirty(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installerCommand", () => {
  test("forwards the recorded install dir to install.sh / install.ps1", () => {
    expect(installerCommand("/s", "/usr/local/bin", false)).toEqual({
      cmd: "bash",
      args: [join("/s", "install.sh"), "--install-dir", "/usr/local/bin"],
    });
    const win = installerCommand("C:/s", "D:/bin", true);
    expect(win.args.slice(-2)).toEqual(["-InstallDir", "D:/bin"]);
  });
});

describe("belz update on a real checkout", () => {
  const g = (cwd: string, ...a: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], {
      cwd,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };

  function repos() {
    const root = scratchDir("upd-");
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    const src = join(root, "src");
    g(root, "init", "-q", "--bare", "-b", "main", origin);
    g(root, "clone", "-q", origin, seed);
    writeFileSync(join(seed, "a.txt"), "v1\n");
    g(seed, "add", "a.txt");
    g(seed, "commit", "-q", "-m", "v1");
    g(seed, "push", "-q", "origin", "HEAD:main");
    g(root, "clone", "-q", "-b", "main", origin, src);
    // origin moves ahead of src
    writeFileSync(join(seed, "a.txt"), "v2\n");
    g(seed, "commit", "-q", "-am", "v2");
    g(seed, "push", "-q", "origin", "HEAD:main");
    const cfg = withTempEnvConfig({ envs: {} });
    const raw = JSON.parse(readFileSync(CONFIG_FILE_PATH, "utf8"));
    raw.install = { sourceDir: src, installDir: join(root, "bin") };
    writeFileSync(CONFIG_FILE_PATH, JSON.stringify(raw));
    reloadConfig();
    return { src, cfg };
  }

  test("--force with staged changes refuses (DIRTY_TREE) and keeps them", async () => {
    const { src, cfg } = repos();
    try {
      writeFileSync(join(src, "wip.txt"), "precious\n");
      g(src, "add", "wip.txt");
      const head = g(src, "rev-parse", "HEAD");
      const r = await runCommand(update, ["--force"]);
      expect(r.envelope?.error?.code).toBe("DIRTY_TREE");
      expect(readFileSync(join(src, "wip.txt"), "utf8")).toBe("precious\n");
      expect(g(src, "diff", "--cached", "--name-only")).toBe("wip.txt");
      expect(g(src, "rev-parse", "HEAD")).toBe(head);
    } finally {
      cfg.restore();
    }
  }, 30_000);

  test("--force with unpushed local commits refuses (LOCAL_COMMITS) and keeps them", async () => {
    const { src, cfg } = repos();
    try {
      writeFileSync(join(src, "mine.txt"), "local\n");
      g(src, "add", "mine.txt");
      g(src, "commit", "-q", "-m", "local work");
      const head = g(src, "rev-parse", "HEAD");
      const r = await runCommand(update, ["--force"]);
      expect(r.envelope?.error?.code).toBe("LOCAL_COMMITS");
      expect(g(src, "rev-parse", "HEAD")).toBe(head);
    } finally {
      cfg.restore();
    }
  }, 30_000);
});
