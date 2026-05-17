import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import {
  CliError,
  ok,
  lifecycle,
  getSourceDir,
  recordBelzMeta,
  type CommandModule,
} from "@belzabar/core";

const isWindows = process.platform === "win32";

interface UpdateArgs {
  check: boolean;
  force: boolean;
}

interface UpdateData {
  sourceDir: string;
  fromSha: string;
  toSha: string;
  branch: string;
  status: "up-to-date" | "updated" | "check-only";
  dirty: boolean;
  rebuilt: boolean;
}

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

function requireGit(sourceDir: string, args: string[], failCode: string): string {
  const r = git(sourceDir, args);
  if (!r.ok) {
    throw new CliError(`git ${args.join(" ")} failed: ${r.err || "unknown error"}`, {
      code: failCode,
    });
  }
  return r.out;
}

// ── command ─────────────────────────────────────────────────────────────────────

const command: CommandModule<UpdateArgs, UpdateData> = {
  schema: "belz.update",

  parseArgs(args) {
    let check = false;
    let force = false;
    for (const token of args) {
      if (token === "--check") check = true;
      else if (token === "--force" || token === "-f") force = true;
      else if (token.startsWith("-")) {
        throw new CliError(`Unknown flag: ${token}`, { code: "UNKNOWN_FLAG" });
      }
    }
    return { check, force };
  },

  async execute(args) {
    const sourceDir = getSourceDir();
    if (!existsSync(join(sourceDir, ".git"))) {
      throw new CliError(
        `belz source checkout not found at ${sourceDir}.\n` +
          `Set "belz.sourceDir" in ~/.belz/config.json to your belz git checkout, or reinstall.`,
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
    const dirty = git(sourceDir, ["status", "--porcelain"]).out.length > 0;

    if (fromSha === remoteSha && !args.force) {
      spin.stop("Already up to date.");
      return ok<UpdateData>({
        sourceDir,
        fromSha,
        toSha: remoteSha,
        branch,
        status: "up-to-date",
        dirty,
        rebuilt: false,
      });
    }

    if (args.check) {
      spin.stop("Update available.");
      return ok<UpdateData>({
        sourceDir,
        fromSha,
        toSha: remoteSha,
        branch,
        status: "check-only",
        dirty,
        rebuilt: false,
      });
    }

    if (dirty && !args.force) {
      spin.error("Working tree has uncommitted changes.");
      throw new CliError(
        `The belz source checkout at ${sourceDir} has uncommitted changes.\n` +
          `Commit/stash them, or re-run with --force to discard and overwrite.`,
        { code: "DIRTY_TREE" }
      );
    }

    // Advance the checkout to the upstream commit.
    spin.message(`Updating ${fromSha} → ${remoteSha}…`);
    if (args.force) {
      requireGit(sourceDir, ["reset", "--hard", upstream], "GIT_RESET_FAILED");
    } else {
      const merged = git(sourceDir, ["merge", "--ff-only", upstream]);
      if (!merged.ok) {
        spin.error("Fast-forward merge failed.");
        throw new CliError(
          `Could not fast-forward to ${upstream}: ${merged.err || "diverged history"}.\n` +
            `Re-run with --force to discard local commits and reset to ${upstream}.`,
          { code: "GIT_MERGE_FAILED" }
        );
      }
    }
    spin.stop(`Source updated to ${remoteSha}.`);

    // Rebuild + reinstall via the platform install script. The script builds
    // before it installs, and aborts on a build failure (`set -euo pipefail` /
    // `$ErrorActionPreference`), so a broken build never replaces the binary.
    const scriptDir = join(sourceDir, "cli", "scripts");
    const installer = isWindows
      ? { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(scriptDir, "install.ps1")] }
      : { cmd: "bash", args: [join(scriptDir, "install.sh")] };

    lifecycle.note(
      "Rebuilding belz",
      "Building the web app and recompiling the binary — this can take a minute."
    );
    const build = spawnSync(installer.cmd, installer.args, { cwd: sourceDir, stdio: "inherit" });
    if (build.status !== 0) {
      throw new CliError(
        `Rebuild failed (exit ${String(build.status)}). Your existing belz binary is unchanged.`,
        { code: "BUILD_FAILED" }
      );
    }

    recordBelzMeta({ version: remoteSha, installedAt: new Date().toISOString() });

    return ok<UpdateData>({
      sourceDir,
      fromSha,
      toSha: remoteSha,
      branch,
      status: "updated",
      dirty,
      rebuilt: true,
    });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as UpdateData;

    if (data.status === "up-to-date") {
      ui.success(`belz is already up to date (${data.fromSha} on ${data.branch}).`);
      return;
    }

    if (data.status === "check-only") {
      ui.warn(`An update is available: ${data.fromSha} → ${data.toSha} (${data.branch}).`);
      if (data.dirty) {
        ui.text("Note: the source checkout has uncommitted changes — `belz update` will need --force.");
      }
      ui.text("Run `belz update` to install it.");
      return;
    }

    ui.success(`belz updated: ${data.fromSha} → ${data.toSha} (${data.branch}).`);
    ui.text("The new binary takes effect on your next `belz` invocation.");
  },
};

export default command;
