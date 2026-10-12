#!/usr/bin/env bun
// `bun run release <patch|minor|major|x.y.z> [--dry-run]` — cut a belz release.
//
// Checks you are on a clean `main` that matches origin/main, bumps apps/cli/package.json,
// commits "chore(release): vX.Y.Z", tags vX.Y.Z and pushes both. The tag starts
// .github/workflows/release.yml, which runs `bun run check`, builds every platform and
// publishes the GitHub Release. --dry-run prints the new version and changes nothing.

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PKG = join(ROOT, "apps/cli/package.json");

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`release: git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    process.exit(1);
  }
  return r.stdout.trim();
}

function die(msg: string): never {
  console.error(`release: ${msg}`);
  process.exit(1);
}

const bump = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!bump) die("usage: bun run release <patch|minor|major|x.y.z> [--dry-run]");

const pkgText = readFileSync(PKG, "utf8");
const current: string = JSON.parse(pkgText).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) die(`apps/cli/package.json version "${current}" is not major.minor.patch`);
const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
const next =
  bump === "major" ? `${maj + 1}.0.0`
  : bump === "minor" ? `${maj}.${min + 1}.0`
  : bump === "patch" ? `${maj}.${min}.${pat + 1}`
  : /^\d+\.\d+\.\d+$/.test(bump) ? bump
  : die(`unknown bump "${bump}"`);
const tag = `v${next}`;

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") die("releases are cut from main");
if (git("status", "--porcelain", "--untracked-files=no") !== "") die("the working tree has uncommitted changes");
git("fetch", "--quiet", "origin", "main", "--tags");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) die("main is not at origin/main; pull or push first");
if (git("tag", "--list", tag) !== "") die(`tag ${tag} already exists`);

console.log(`belz ${current} → ${next} (${tag})`);
if (dryRun) process.exit(0);

writeFileSync(PKG, pkgText.replace(`"version": "${current}"`, `"version": "${next}"`));
git("add", PKG);
git("commit", "-m", `chore(release): ${tag}`);
git("tag", "-a", tag, "-m", `belz ${tag}`);
git("push", "origin", "main", tag);
console.log(`pushed ${tag}; the release workflow builds and publishes it.`);
