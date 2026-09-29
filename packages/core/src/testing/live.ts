// Opt-in live tests against sems-dev. Never run by default.
//
//   BELZ_LIVE=sems-dev bun test tests/live                    → read-only suites
//   BELZ_LIVE=sems-dev BELZ_LIVE_WRITE=1 bun test tests/live  → + write suites
//
// Any other BELZ_LIVE value is refused (throws at load). Live CLI runs use a
// tmp BELZ_HOME seeded with a *copy* of the real config.json and sems-dev
// session, so the real ~/.belz is only read, never written.
// Write suites: category Test-Parth only, `belz_tst_` prefix, clean up in
// afterAll, and call registerLiveResource() for everything created.

import { afterAll, describe } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseGlobalFlags } from "../runner";
import { scratchDir } from "./scratch";
import { repoRoot, spawnCli, type SpawnCliOptions, type SpawnResult } from "./spawn-cli";

export const LIVE_ENV = "sems-dev";
export const LIVE_WRITE_PREFIX = "belz_tst_";

function liveMode(): { read: boolean; write: boolean } {
  const live = process.env.BELZ_LIVE;
  if (!live) return { read: false, write: false };
  if (live !== LIVE_ENV) {
    throw new Error(`BELZ_LIVE=${live} refused: live tests only run against ${LIVE_ENV}.`);
  }
  return { read: true, write: process.env.BELZ_LIVE_WRITE === "1" };
}

/** The seeded home holds a copy of real credentials: drop it after each live block. */
function withLiveCleanup(fn: () => void): () => void {
  return () => {
    afterAll(() => {
      if (seededHome) rmSync(seededHome, { recursive: true, force: true });
      seededHome = null;
    });
    fn();
  };
}

/** A describe block that only runs when BELZ_LIVE=sems-dev. */
export function describeLive(name: string, fn: () => void): void {
  (liveMode().read ? describe : describe.skip)(`[live ${LIVE_ENV}] ${name}`, withLiveCleanup(fn));
}

/** A describe block that only runs when BELZ_LIVE=sems-dev and BELZ_LIVE_WRITE=1. */
export function describeLiveWrite(name: string, fn: () => void): void {
  const m = liveMode();
  (m.read && m.write ? describe : describe.skip)(`[live-write ${LIVE_ENV}] ${name}`, withLiveCleanup(fn));
}

let seededHome: string | null = null;

/** tmp BELZ_HOME holding copies of the real config.json + sems-dev session. */
export function liveBelzHome(): string {
  if (seededHome) return seededHome;
  const source = process.env.BELZ_LIVE_SOURCE_HOME ?? join(homedir(), ".belz");
  const home = scratchDir("live-home-");
  const config = join(source, "config.json");
  if (!existsSync(config)) throw new Error(`live tests need ${config} (credentials for ${LIVE_ENV})`);
  copyFileSync(config, join(home, "config.json"));
  const session = join(source, "sessions", `${LIVE_ENV}.json`);
  if (existsSync(session)) {
    mkdirSync(join(home, "sessions"), { recursive: true });
    copyFileSync(session, join(home, "sessions", `${LIVE_ENV}.json`));
  }
  return (seededHome = home);
}

/** Spawn the CLI against sems-dev. Refuses any other --env; adds `--env sems-dev` when absent. */
export async function spawnLive(argv: string[], opts: SpawnCliOptions = {}): Promise<SpawnResult> {
  const { envName, error } = parseGlobalFlags(argv);
  if (error) throw new Error(`spawnLive: ${error.message}`);
  if (envName !== null && envName !== LIVE_ENV) {
    throw new Error(`spawnLive refused --env ${envName}: live tests only run against ${LIVE_ENV}.`);
  }
  if (!liveMode().read) throw new Error("spawnLive called outside a describeLive block (BELZ_LIVE unset)");
  const args = envName === null ? [...argv, "--env", LIVE_ENV] : argv;
  return spawnCli(args, { ...opts, env: { BELZ_HOME: liveBelzHome(), ...opts.env } });
}

export interface LiveResource {
  kind: string; // method / table / row / suite / category
  identifier: string;
  purpose: string;
  agent?: string;
  cleaned?: string;
}

/** Path of the live-resources ledger (BELZ_LIVE_RESOURCES, else ../belzabar-workspace/live-resources.md). */
export function liveResourcesPath(): string {
  return process.env.BELZ_LIVE_RESOURCES ?? join(repoRoot(), "..", "belzabar-workspace", "live-resources.md");
}

/** Append a row to the live-resources ledger, when the file exists. Returns whether it was written. */
export function registerLiveResource(r: LiveResource): boolean {
  const path = liveResourcesPath();
  if (!existsSync(path)) return false;
  const now = new Date();
  // bun test runs with TZ=UTC, so say so rather than print a misleading local time.
  const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  appendFileSync(
    path,
    `| ${hhmm} | ${cell(r.agent ?? "live-test")} | ${cell(r.kind)} | ${cell(r.identifier)} | ${cell(r.purpose)} | ${cell(r.cleaned ?? "no")} |\n`
  );
  return true;
}

/**
 * Mark a ledger row cleaned in place: rewrites the last cell of the last row
 * whose identifier cell equals `identifier`. Returns whether a row was updated.
 */
export function markLiveResourceCleaned(identifier: string, note: string): boolean {
  const path = liveResourcesPath();
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, "utf8").split("\n");
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  for (let i = lines.length - 1; i >= 0; i--) {
    const cells = lines[i]!.split(/(?<!\\)\|/);
    // "| a | b | c | d | e | f |" → ["", a, b, c, d, e, f, ""]
    if (cells.length !== 8 || cells[4]!.trim() !== identifier) continue;
    cells[6] = ` ${cell(note)} `;
    lines[i] = cells.join("|");
    writeFileSync(path, lines.join("\n"));
    return true;
  }
  return false;
}
