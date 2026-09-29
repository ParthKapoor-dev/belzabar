// Locate the repo / CLI entry points and spawn the CLI as a real process.

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { CommandEnvelope } from "../command";
import type { NamespacedCliOptions } from "../runner";
import { scratchDir } from "./scratch";

let cachedRoot: string | null = null;

/** The monorepo root (the dir whose package.json is named "belzabar"). */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = import.meta.dir;
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === "belzabar") return (cachedRoot = dir);
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("core/testing: could not find the belzabar repo root");
    dir = parent;
  }
}

/** The CLI workspace dir. */
export function cliDir(): string {
  return join(repoRoot(), "apps", "cli");
}

/** Dev entry point (`bun <this> ad show …`). */
export function cliEntry(): string {
  return join(cliDir(), "bin", "cli.ts");
}

/** Entry compiled into the release binary (the same file as the dev entry). */
export function cliBuildEntry(): string {
  return cliEntry();
}

/** The namespace/command maps the entry builds from the static registries (every registered command). */
export async function loadDevCliOptions(): Promise<NamespacedCliOptions> {
  const mod = await import(join(cliDir(), "bin", "options.ts"));
  return mod.buildCliOptions() as NamespacedCliOptions;
}

let scratchHome: string | null = null;
function defaultHome(): string {
  if (!scratchHome) scratchHome = scratchDir("spawn-home-");
  return scratchHome;
}

export interface SpawnCliOptions {
  /** Extra env vars (merged over a minimal isolated env). */
  env?: Record<string, string | undefined>;
  /** Working dir. Default: a scratch dir, so bun never autoloads a repo `.env`. */
  cwd?: string;
  /** Run this executable (e.g. a compiled belz) instead of `bun cli.ts`. */
  bin?: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** stdout parsed as JSON when it is a single envelope, else null. */
  envelope: CommandEnvelope | null;
}

/**
 * Spawn the CLI in an isolated env: HOME is a scratch dir, BELZ_HOME is the
 * test's BELZ_HOME (preload tmp dir), no inherited credentials.
 */
export async function spawnCli(argv: string[], opts: SpawnCliOptions = {}): Promise<SpawnResult> {
  const home = defaultHome();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    BELZ_HOME: process.env.BELZ_HOME ?? join(home, ".belz"),
    EDITOR: "false",
    VISUAL: "false",
    NO_COLOR: "1",
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const cmd = opts.bin ? [opts.bin, ...argv] : [process.execPath, cliEntry(), ...argv];
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? home,
    env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  let envelope: CommandEnvelope | null = null;
  try {
    envelope = JSON.parse(stdout);
  } catch { /* not JSON */ }
  return { stdout, stderr, exitCode, envelope };
}
