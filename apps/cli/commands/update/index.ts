import { spawnSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  CliError,
  defineArgs,
  ok,
  lifecycle,
  getInstallDir,
  getSourceDir,
  isCompiledEntry,
  loadConfigFileRaw,
  recordBelzMeta,
  type CommandModule,
} from "@belzabar/core";
import { installKind, rollbackBinary, swapInBinary } from "../../lib/auto-update";
import { compareVersions, downloadVerifiedAsset, fetchManifest } from "../../lib/release";
import { buildInfo } from "../../bin/build-info" with { type: "macro" };

const BUILD = buildInfo();

const isWindows = process.platform === "win32";

interface UpdateArgs {
  check: boolean;
  force: boolean;
  rollback: boolean;
}

/** A binary install (installed from a release): versions, not commits. */
interface BinaryUpdateData {
  mode: "binary";
  status: "up-to-date" | "updated" | "check-only" | "rolled-back";
  fromVersion: string;
  /** The release version installed or available; absent after a rollback. */
  toVersion?: string;
  /** Set when config.json `update.pin` chose the version. */
  pinned?: string;
  binary: string;
}

interface SourceUpdateData {
  mode: "source";
  sourceDir: string;
  fromSha: string;
  toSha: string;
  branch: string;
  status: "up-to-date" | "updated" | "rebuilt" | "check-only";
  dirty: boolean;
  rebuilt: boolean;
  installDir?: string;
}

type UpdateData = BinaryUpdateData | SourceUpdateData;

// ── git helpers ────────────────────────────────────────────────────────────────

function git(sourceDir: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", sourceDir, ...args], { encoding: "utf8" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new CliError("`git` was not found on PATH — it is required for `belz update`.", {
      code: "GIT_NOT_FOUND",
    });
  }
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/**
 * Does the checkout have local work a fast-forward could clobber? Tracked
 * modifications and staged changes only (NEW-4): untracked files (a dev
 * checkout's `.claude/`, scratch files) never block — `merge --ff-only`
 * itself refuses if the update would overwrite one.
 */
export function worktreeDirty(sourceDir: string): boolean {
  return git(sourceDir, ["status", "--porcelain", "--untracked-files=no"]).out.length > 0;
}

function requireGit(sourceDir: string, args: string[], failCode: string): string {
  const r = git(sourceDir, args);
  if (!r.ok) {
    throw new CliError(`git ${args.join(" ")} failed: ${r.err || "unknown error"}`, {
      code: failCode,
    });
  }
  return r.out;
}

export interface UpdateState {
  /** Commits on origin/<branch> not in HEAD. */
  behind: number;
  /** Local commits not on origin/<branch>. */
  ahead: number;
  /** Uncommitted (staged, unstaged or untracked) changes. */
  dirty: boolean;
}

export type UpdatePlan =
  | { action: "up-to-date" }
  | { action: "check-only" }
  | { action: "rebuild" }
  | { action: "fast-forward" }
  | { action: "refuse"; code: "DIRTY_TREE" | "LOCAL_COMMITS"; reason: string };

/**
 * What `belz update` does for a checkout state. It never discards
 * work: the checkout only moves by fast-forward, and a tree with uncommitted
 * changes or local commits is refused when there is something to pull.
 * `--force` only means "rebuild even when already up to date" — it no longer
 * hard-resets (the recorded sourceDir can be a developer's own checkout).
 */
export function planUpdate(state: UpdateState, opts: { check: boolean; force: boolean }): UpdatePlan {
  if (state.behind === 0) return { action: opts.force && !opts.check ? "rebuild" : "up-to-date" };
  if (opts.check) return { action: "check-only" };
  if (state.dirty) {
    return { action: "refuse", code: "DIRTY_TREE", reason: "it has uncommitted or staged changes" };
  }
  if (state.ahead > 0) {
    return {
      action: "refuse",
      code: "LOCAL_COMMITS",
      reason: `it has ${state.ahead} local commit${state.ahead === 1 ? "" : "s"} not on origin`,
    };
  }
  return { action: "fast-forward" };
}

/** The platform install script invocation, installing to the recorded install dir. */
export function installerCommand(
  scriptDir: string,
  installDir: string,
  windows: boolean = isWindows,
): { cmd: string; args: string[] } {
  return windows
    ? {
        cmd: "powershell",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scriptDir, "install.ps1"), "-InstallDir", installDir],
      }
    : { cmd: "bash", args: [join(scriptDir, "install.sh"), "--install-dir", installDir] };
}

// ── command ─────────────────────────────────────────────────────────────────────

export const args = defineArgs({
  command: "belz update",
  flags: {
    check: { type: "boolean" },
    force: { type: "boolean", alias: ["-f"] },
    rollback: { type: "boolean" },
  },
  exclusive: [["rollback", "check"], ["rollback", "force"]],
});

/** `belz update` for a binary install: download the release binary, verify it, swap it in. */
async function updateBinary(args: UpdateArgs): Promise<BinaryUpdateData> {
  if (!isCompiledEntry(process.argv[1])) {
    throw new CliError("This belz runs from source; only a compiled binary can update itself from a release.", {
      code: "UPDATE_NOT_COMPILED",
    });
  }
  const binary = process.execPath;
  const base = { mode: "binary" as const, fromVersion: BUILD.version, binary };
  if (args.rollback) {
    try {
      rollbackBinary(binary);
    } catch (e) {
      throw new CliError(`Cannot roll back: ${(e as Error).message}.`, { code: "UPDATE_NO_PREVIOUS" });
    }
    return { ...base, status: "rolled-back" };
  }
  const pin = loadConfigFileRaw().update?.pin?.replace(/^v/, "");
  const spin = lifecycle.spinner("Checking for updates");
  spin.start(pin ? `Reading release v${pin}…` : "Reading the latest release…");
  let manifest;
  try {
    manifest = await fetchManifest(pin);
  } catch (e) {
    spin.error("Could not read the release.");
    throw e;
  }
  const cmp = compareVersions(manifest.version, BUILD.version);
  const current = pin ? cmp === 0 : cmp <= 0;
  const result = { ...base, toVersion: manifest.version, ...(pin ? { pinned: pin } : {}) };
  if (current && !args.force) {
    spin.stop("Already up to date.");
    return { ...result, status: "up-to-date" };
  }
  if (args.check) {
    spin.stop("Update available.");
    return { ...result, status: "check-only" };
  }
  spin.message(`Downloading v${manifest.version}…`);
  const next = `${binary}.next`;
  try {
    await downloadVerifiedAsset(manifest, next);
    swapInBinary(binary, next);
  } catch (e) {
    spin.error("Update failed; your belz binary is unchanged.");
    throw e;
  } finally {
    rmSync(next, { force: true });
  }
  recordBelzMeta({ version: manifest.version, installedAt: new Date().toISOString() });
  spin.stop(`Installed v${manifest.version}.`);
  return { ...result, status: "updated" };
}

const command: CommandModule<UpdateArgs, UpdateData> = {
  /** Rebuilds and reinstalls the local belz binary. */
  writesLocal: true,
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    return { check: flags.check, force: flags.force, rollback: flags.rollback };
  },

  async execute(args) {
    if (installKind(loadConfigFileRaw()) === "binary") return ok<UpdateData>(await updateBinary(args));
    if (args.rollback) {
      throw new CliError("--rollback is for binary installs; roll a source install back in its checkout.", {
        code: "UPDATE_NO_PREVIOUS",
      });
    }
    const sourceDir = getSourceDir();
    if (!existsSync(join(sourceDir, ".git"))) {
      throw new CliError(
        `belz source checkout not found at ${sourceDir}.\n` +
          `Set "install.sourceDir" in ~/.wi-impl/config.json to your belz git checkout, or reinstall.`,
        { code: "SOURCE_NOT_FOUND" }
      );
    }

    const branch = requireGit(sourceDir, ["rev-parse", "--abbrev-ref", "HEAD"], "GIT_BRANCH_FAILED");
    const upstream = `origin/${branch}`;

    const spin = lifecycle.spinner("Checking for updates");
    spin.start(`Fetching ${upstream}…`);
    const fetched = git(sourceDir, ["fetch", "origin", branch]);
    if (!fetched.ok) {
      spin.error("git fetch failed.");
      throw new CliError(`Could not fetch ${upstream}: ${fetched.err || "unknown error"}`, {
        code: "GIT_FETCH_FAILED",
      });
    }

    const fromSha = requireGit(sourceDir, ["rev-parse", "--short", "HEAD"], "GIT_REV_FAILED");
    const remoteSha = requireGit(sourceDir, ["rev-parse", "--short", upstream], "GIT_REV_FAILED");
    const dirty = worktreeDirty(sourceDir);
    const counts = requireGit(sourceDir, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], "GIT_REV_FAILED");
    const [ahead = 0, behind = 0] = counts.split(/\s+/).map((n) => Number(n) || 0);

    const plan = planUpdate({ ahead, behind, dirty }, args);
    const base = { mode: "source" as const, sourceDir, fromSha, toSha: remoteSha, branch, dirty };

    if (plan.action === "up-to-date") {
      spin.stop("Already up to date.");
      return ok<UpdateData>({ ...base, status: "up-to-date", rebuilt: false });
    }
    if (plan.action === "check-only") {
      spin.stop("Update available.");
      return ok<UpdateData>({ ...base, status: "check-only", rebuilt: false });
    }
    if (plan.action === "refuse") {
      spin.error("Source checkout has local work.");
      throw new CliError(
        `Not updating the belz source checkout at ${sourceDir}: ${plan.reason}.\n` +
          `belz update never discards local work. Commit/push or stash it, or reset the checkout yourself ` +
          `(git -C ${sourceDir} reset --hard ${upstream}), then re-run.`,
        { code: plan.code, details: { sourceDir, branch, ahead, behind, dirty } },
      );
    }
    if (plan.action === "fast-forward") {
      spin.message(`Updating ${fromSha} → ${remoteSha}…`);
      const merged = git(sourceDir, ["merge", "--ff-only", upstream]);
      if (!merged.ok) {
        spin.error("Fast-forward merge failed.");
        throw new CliError(`Could not fast-forward to ${upstream}: ${merged.err || "diverged history"}.`, {
          code: "GIT_MERGE_FAILED",
        });
      }
      spin.stop(`Source updated to ${remoteSha}.`);
    } else {
      spin.stop(`Rebuilding ${fromSha} (no source change).`);
    }

    // Rebuild + reinstall via the platform install script. The script builds
    // before it installs, and aborts on a build failure (`set -euo pipefail` /
    // `$ErrorActionPreference`), so a broken build never replaces the binary.
    const installDir = getInstallDir();
    const installer = installerCommand(join(sourceDir, "apps", "cli", "scripts"), installDir);

    lifecycle.note(
      "Rebuilding belz",
      "Recompiling the binary — this can take a minute."
    );
    const build = spawnSync(installer.cmd, installer.args, { cwd: sourceDir, stdio: "inherit" });
    if (build.status !== 0) {
      throw new CliError(
        `Rebuild failed (exit ${String(build.status)}). Your existing belz binary is unchanged.`,
        { code: "BUILD_FAILED" }
      );
    }

    const toSha = plan.action === "fast-forward" ? remoteSha : fromSha;
    recordBelzMeta({ version: toSha, installDir, installedAt: new Date().toISOString() });

    return ok<UpdateData>({
      ...base,
      toSha,
      status: plan.action === "fast-forward" ? "updated" : "rebuilt",
      rebuilt: true,
      installDir,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const all = envelope.data as UpdateData;
    if (all.mode === "binary") {
      if (all.status === "rolled-back") ui.success(`Rolled back to the previous belz binary (was v${all.fromVersion}).`);
      else if (all.status === "up-to-date") ui.success(`belz v${all.fromVersion} is up to date${all.pinned ? " (pinned)" : ""}.`);
      else if (all.status === "check-only") {
        ui.warn(`An update is available: v${all.fromVersion} → v${all.toVersion}.`);
        ui.text("Run `belz update` to install it.");
      } else ui.success(`belz updated: v${all.fromVersion} → v${all.toVersion}. It takes effect on your next belz run.`);
      return;
    }
    const data = all;

    if (data.status === "up-to-date") {
      ui.success(`belz is already up to date (${data.fromSha} on ${data.branch}).`);
      return;
    }

    if (data.status === "check-only") {
      ui.warn(`An update is available: ${data.fromSha} → ${data.toSha} (${data.branch}).`);
      if (data.dirty) {
        ui.text("Note: the source checkout has uncommitted changes — commit or stash them first; `belz update` never discards them.");
      }
      ui.text("Run `belz update` to install it.");
      return;
    }

    if (data.status === "rebuilt") ui.success(`belz rebuilt at ${data.fromSha} (${data.branch}).`);
    else ui.success(`belz updated: ${data.fromSha} → ${data.toSha} (${data.branch}).`);
    ui.text("The new binary takes effect on your next `belz` invocation.");
  },
};

export default command;
