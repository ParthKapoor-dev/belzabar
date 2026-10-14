// Background auto-update for binary installs.
//
// At most once per 24 h, a wi-impl run spawns a detached copy of itself (WI_IMPL_UPDATE_WORKER=1)
// and carries on without waiting. The worker reads the latest release's manifest.json and, when
// it is newer within the same major version, downloads this platform's binary to
// `<wi-impl>.next`, checks its sha256, and swaps it in (the old binary is kept as `<wi-impl>.prev` for
// `wi-impl update --rollback`). A command that is already running keeps executing the old file,
// so the new version takes effect on the next run, which prints a one-line notice on stderr.
//
// Never for: source installs or dev runs, dirty builds, CI, WI_IMPL_NO_UPDATE=1,
// `update.auto: false` or `update.pin` in config.json. It never writes to stdout and never
// throws into the command that triggered it.

import { spawn } from "child_process";
import { closeSync, copyFileSync, existsSync, linkSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { BELZ_CONFIG_DIR, installMeta, isCompiledEntry, loadConfigFileRaw, recordBelzMeta, trustedBelzEnv, writeConfigFile, type BelzConfigFile } from "@belzabar/core";
import { compareVersions, downloadVerifiedAsset, fetchManifest, sameMajor } from "./release";

/** How often a binary install checks for a new release. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface BuildIdentity {
  version: string;
  dirty: boolean;
}

interface UpdateState {
  lastCheckAt?: number;
  latestVersion?: string;
  /** A newer major version exists; auto-update does not cross majors. */
  majorAvailable?: string;
  lastError?: string;
  /** Set by the worker after a swap; the next run prints the notice once. */
  updated?: { from: string; to: string; at: number; noticeShown: boolean };
}

const statePath = () => join(BELZ_CONFIG_DIR, "update-state.json");

function readUpdateState(): UpdateState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

function writeUpdateState(patch: Partial<UpdateState>): void {
  try {
    const next = { ...readUpdateState(), ...patch };
    const tmp = `${statePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, statePath());
  } catch {
    /* best effort: a lost state write only means one extra check */
  }
}

/** "binary" only when the release installer recorded it; anything else is treated as a source install. */
export function installKind(config: BelzConfigFile): "binary" | "source" {
  return installMeta(config)?.installKind === "binary" ? "binary" : "source";
}

/**
 * The sentence added to an unknown command/flag error: name the newer release when the last
 * check found one, say nothing when a check within 24 h found this version current, and
 * otherwise point at `wi-impl update --check`.
 */
export function updateHint(build: BuildIdentity, now = Date.now()): string | null {
  const state = readUpdateState();
  const latest = state.latestVersion;
  if (latest && compareVersions(latest, build.version) > 0) {
    return `wi-impl ${latest} is available (this is ${build.version}) and may have it: run \`wi-impl update\`.`;
  }
  const fresh = state.lastCheckAt !== undefined && now - state.lastCheckAt < CHECK_INTERVAL_MS;
  if (fresh && latest) return null;
  return "If it is new, check for a newer wi-impl with `wi-impl update --check`.";
}

/** Why this run must not auto-update, or null when it may. */
export function autoUpdateBlocker(
  build: BuildIdentity,
  ctx: { argv?: readonly string[]; env?: NodeJS.ProcessEnv; config?: BelzConfigFile } = {},
): string | null {
  const argv = ctx.argv ?? process.argv;
  const env = ctx.env ?? process.env;
  if (!isCompiledEntry(argv[1])) return "not a compiled binary";
  if (build.dirty) return "built from uncommitted changes";
  if (env.CI) return "running in CI";
  const belzEnv = ctx.env ? ctx.env : trustedBelzEnv();
  if (belzEnv.WI_IMPL_NO_UPDATE === "1") return "WI_IMPL_NO_UPDATE=1";
  let config: BelzConfigFile;
  try {
    config = ctx.config ?? loadConfigFileRaw();
  } catch {
    return "config.json is unreadable";
  }
  if (config.update?.auto === false) return "update.auto is false in config.json";
  if (config.update?.pin) return `pinned to ${config.update.pin} in config.json`;
  if (installKind(config) !== "binary") return "source install (update with `wi-impl update`)";
  return null;
}

/**
 * Called once at startup by bin/cli.ts. Prints the "updated" notice owed from a previous
 * background swap, then starts a background check when 24 h have passed. Never throws,
 * never waits on the network.
 */
export function autoUpdateTick(build: BuildIdentity, now = Date.now()): void {
  try {
    const state = readUpdateState();
    const u = state.updated;
    if (u && !u.noticeShown && u.to === build.version) {
      const llm = process.argv.includes("--llm");
      if (!llm && process.stderr.isTTY) process.stderr.write(`wi-impl updated ${u.from} → ${u.to}\n`);
      writeUpdateState({ updated: { ...u, noticeShown: true } });
    }
    if (autoUpdateBlocker(build) !== null) return;
    if (state.lastCheckAt && now - state.lastCheckAt < CHECK_INTERVAL_MS) return;
    writeUpdateState({ lastCheckAt: now }); // claim the slot before spawning
    const child = spawn(process.execPath, [], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, WI_IMPL_UPDATE_WORKER: "1" },
    });
    child.unref();
  } catch {
    /* never break the user's command */
  }
}

/**
 * The binary file this process runs: the real path, so a run through the `belz` alias (a symlink
 * to `wi-impl`) updates `wi-impl` and never replaces the alias with a copy.
 */
export function installedBinary(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** Atomically replace `exe` with `next`, keeping the old binary as `<exe>.prev`. */
export function swapInBinary(exe: string, next: string): void {
  const prev = `${exe}.prev`;
  rmSync(prev, { force: true });
  if (process.platform === "win32") {
    // A running .exe can be renamed but not overwritten.
    renameSync(exe, prev);
    try {
      renameSync(next, exe);
    } catch (e) {
      renameSync(prev, exe);
      throw e;
    }
    return;
  }
  try {
    linkSync(exe, prev);
  } catch {
    copyFileSync(exe, prev);
  }
  renameSync(next, exe); // atomic; a running wi-impl keeps the old inode
}

/** Swap `exe` and `<exe>.prev` back. Throws when there is no previous binary. */
export function rollbackBinary(exe: string): void {
  const prev = `${exe}.prev`;
  if (!existsSync(prev)) throw new Error(`no previous binary at ${prev}`);
  const hold = `${exe}.rollback-${process.pid}`;
  renameSync(exe, hold);
  try {
    renameSync(prev, exe);
  } catch (e) {
    renameSync(hold, exe);
    throw e;
  }
  renameSync(hold, prev);
}

/** The detached worker started by autoUpdateTick (WI_IMPL_UPDATE_WORKER=1). */
export async function runUpdateWorker(build: BuildIdentity): Promise<void> {
  const exe = installedBinary();
  const lock = `${exe}.update-lock`;
  let fd: number;
  try {
    // A lock older than 10 minutes is from a worker that died.
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10 * 60 * 1000) rmSync(lock, { force: true });
    fd = openSync(lock, "wx");
  } catch {
    return; // another worker is running
  }
  try {
    if (autoUpdateBlocker(build) !== null) return;
    const manifest = await fetchManifest(undefined, 15_000);
    writeUpdateState({ latestVersion: manifest.version, lastError: undefined });
    if (compareVersions(manifest.version, build.version) <= 0) return;
    if (!sameMajor(manifest.version, build.version)) {
      writeUpdateState({ majorAvailable: manifest.version });
      return;
    }
    const next = `${exe}.next`;
    await downloadVerifiedAsset(manifest, next);
    swapInBinary(exe, next);
    recordBelzMeta({ version: manifest.version, installedAt: new Date().toISOString() });
    writeUpdateState({ updated: { from: build.version, to: manifest.version, at: Date.now(), noticeShown: false } });
  } catch (e) {
    writeUpdateState({ lastError: (e as Error).message });
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
    rmSync(`${exe}.next`, { force: true });
  }
}

/**
 * WI_IMPL_RECORD_INSTALL=binary: the release installer records this binary install, then exits.
 * WI_IMPL_RECORD_PIN=x.y.z (an explicit `--version` install) also pins that version, so the
 * auto-update does not replace the version that was asked for; without it any pin is cleared.
 */
export function recordBinaryInstall(build: BuildIdentity): void {
  recordBelzMeta({
    installKind: "binary",
    installDir: dirname(installedBinary()),
    version: build.version,
    installedAt: new Date().toISOString(),
  });
  const pin = trustedBelzEnv().WI_IMPL_RECORD_PIN?.replace(/^v/, "");
  const config = loadConfigFileRaw();
  const update = { ...config.update };
  if (pin) update.pin = pin;
  else delete update.pin;
  writeConfigFile({ ...config, update });
}
