#!/usr/bin/env bun
// build-release.ts — compile the release binaries and write the release manifest.
//
//   bun apps/cli/scripts/build-release.ts [--targets linux-x64,…] [--out <dir>] [--sign]
//   bun apps/cli/scripts/build-release.ts --manifest-only [--out <dir>]
//
// Build mode compiles `belz-<target>` for each target (default: all of RELEASE_TARGETS) into
// --out (default dist/release). --sign ad-hoc codesigns the darwin binaries (macOS only:
// Apple Silicon refuses unsigned ones). --manifest-only hashes every belz-* binary already in
// --out and writes SHA256SUMS, manifest.json and the two installers next to them, so CI can
// build on several runners and assemble one release. The version is apps/cli/package.json's.

import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { RELEASE_TARGETS, assetName, sha256Hex, type ReleaseTarget } from "../lib/release";

const REPO = resolve(import.meta.dir, "../../..");
const CLI = join(REPO, "apps/cli");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd: string, args: string[], cwd = REPO): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`build-release: ${cmd} ${args.join(" ")} failed (exit ${String(r.status)})`);
    process.exit(1);
  }
}

const out = resolve(flag("--out") ?? join(REPO, "dist/release"));
const version: string = JSON.parse(readFileSync(join(CLI, "package.json"), "utf8")).version;
mkdirSync(out, { recursive: true });

if (!process.argv.includes("--manifest-only")) {
  const targets = (flag("--targets")?.split(",") ?? [...RELEASE_TARGETS]) as ReleaseTarget[];
  for (const t of targets) {
    if (!(RELEASE_TARGETS as readonly string[]).includes(t)) {
      console.error(`build-release: unknown target ${t} (known: ${RELEASE_TARGETS.join(", ")})`);
      process.exit(1);
    }
    const file = join(out, assetName(t));
    console.log(`→ ${assetName(t)} (v${version})`);
    run("bun", ["build", "--compile", "--minify", `--target=bun-${t}`, "./bin/cli.ts", "--outfile", file], CLI);
    if (t.startsWith("darwin") && process.argv.includes("--sign")) {
      if (process.platform !== "darwin") {
        console.error("build-release: --sign needs macOS (codesign)");
        process.exit(1);
      }
      run("codesign", ["--remove-signature", file]);
      run("codesign", ["--force", "--sign", "-", file]);
    }
  }
  process.exit(0);
}

// ── manifest ────────────────────────────────────────────────────────────────
const sha = process.env.GITHUB_SHA?.slice(0, 7) ?? spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
const assets: Record<string, { name: string; sha256: string }> = {};
const sums: string[] = [];
for (const t of RELEASE_TARGETS) {
  const name = assetName(t);
  const file = join(out, name);
  if (!existsSync(file)) {
    console.error(`build-release: ${name} is missing from ${out}; every release ships all targets`);
    process.exit(1);
  }
  const sha256 = sha256Hex(readFileSync(file));
  assets[t] = { name, sha256 };
  sums.push(`${sha256}  ${name}`);
}
const stray = readdirSync(out).filter((f) => f.startsWith("belz-") && !Object.values(assets).some((a) => a.name === f));
if (stray.length) console.warn(`build-release: ignoring ${stray.join(", ")}`);

writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
writeFileSync(
  join(out, "manifest.json"),
  `${JSON.stringify({ version, sha, publishedAt: new Date().toISOString(), assets }, null, 2)}\n`,
);
copyFileSync(join(REPO, "install.sh"), join(out, "install.sh"));
copyFileSync(join(REPO, "install.ps1"), join(out, "install.ps1"));
console.log(`✓ manifest for v${version} (${sha}) in ${out}`);
