// `wi-impl cache prune-local` — local-only cleanup of stale cache artifacts left
// from before caches became env-scoped (see packages/core/src/cache.ts) plus
// abandoned `.refresh/*.lock` files (packages/core/src/swr.ts). No network,
// not environment-specific (writesLocal, not writes).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { runCommand, scratchDir } from "@belzabar/core/testing";
import command, { pruneLocalCache, scanFlatCacheFiles, scanStaleLocks } from "../commands/cache/index";

function touchAge(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

describe("scanFlatCacheFiles", () => {
  test("flags a flat <namespace>/<key>.json file, leaves env-nested ones alone", () => {
    const cacheDir = scratchDir("prune-flat-");
    mkdirSync(join(cacheDir, "methods", "orb-dev"), { recursive: true });
    writeFileSync(join(cacheDir, "methods", "legacy-uuid.json"), '{"a":1}');
    writeFileSync(join(cacheDir, "methods", "orb-dev", "current-uuid.json"), '{"a":1}');

    const { items, skippedNamespaces } = scanFlatCacheFiles(cacheDir);
    expect(items.map(i => i.path)).toEqual(["methods/legacy-uuid.json"]);
    expect(skippedNamespaces).toEqual([]);
  });

  test("skips namespaces that are flat by design (method-finder, page-finder)", () => {
    const cacheDir = scratchDir("prune-unscoped-");
    mkdirSync(join(cacheDir, "method-finder"), { recursive: true });
    mkdirSync(join(cacheDir, "page-finder"), { recursive: true });
    writeFileSync(join(cacheDir, "method-finder", "index-v1-orb-dev.json"), "{}");
    writeFileSync(join(cacheDir, "page-finder", "index-v1-orb-dev.json"), "{}");

    const { items, skippedNamespaces } = scanFlatCacheFiles(cacheDir);
    expect(items).toEqual([]);
    expect(skippedNamespaces).toEqual(["method-finder", "page-finder"]);
  });

  test("never touches a file at the cache root that isn't inside a namespace directory (e.g. dns.json)", () => {
    const cacheDir = scratchDir("prune-dns-");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "dns.json"), "{}");

    const { items } = scanFlatCacheFiles(cacheDir);
    expect(items).toEqual([]);
  });

  test("an empty or missing cache dir scans clean", () => {
    const cacheDir = scratchDir("prune-missing-");
    rmSync(cacheDir, { recursive: true, force: true });
    const { items, skippedNamespaces } = scanFlatCacheFiles(cacheDir);
    expect(items).toEqual([]);
    expect(skippedNamespaces).toEqual([]);
  });
});

describe("scanStaleLocks", () => {
  test("flags .refresh/*.lock files older than the threshold, ignores fresh ones", () => {
    const cacheDir = scratchDir("prune-locks-");
    const refreshDir = join(cacheDir, "pages", "orb-dev", ".refresh");
    mkdirSync(refreshDir, { recursive: true });
    writeFileSync(join(refreshDir, "stale.lock"), "123");
    touchAge(join(refreshDir, "stale.lock"), 15 * 60 * 1000);
    writeFileSync(join(refreshDir, "fresh.lock"), "456");

    const items = scanStaleLocks(cacheDir, 10 * 60 * 1000);
    expect(items.map(i => i.path)).toEqual(["pages/orb-dev/.refresh/stale.lock"]);
  });

  test("also flags a legacy top-level .refresh dir (pre env-scoping)", () => {
    const cacheDir = scratchDir("prune-legacy-locks-");
    const refreshDir = join(cacheDir, "pages", ".refresh");
    mkdirSync(refreshDir, { recursive: true });
    writeFileSync(join(refreshDir, "stale.lock"), "123");
    touchAge(join(refreshDir, "stale.lock"), 20 * 60 * 1000);

    const items = scanStaleLocks(cacheDir, 10 * 60 * 1000);
    expect(items.map(i => i.path)).toEqual(["pages/.refresh/stale.lock"]);
  });
});

describe("pruneLocalCache", () => {
  test("dry run (yes:false) reports candidates but deletes nothing", () => {
    const cacheDir = scratchDir("prune-dryrun-");
    mkdirSync(join(cacheDir, "definitions"), { recursive: true });
    const flatFile = join(cacheDir, "definitions", "legacy.json");
    writeFileSync(flatFile, "{}");

    const data = pruneLocalCache(cacheDir, { yes: false });
    expect(data.dryRun).toBe(true);
    expect(data.flatFiles.scanned).toBe(1);
    expect(data.removed).toEqual({ files: 0, bytes: 0 });
    expect(existsSync(flatFile)).toBe(true);
  });

  test("--yes deletes flat files and stale locks, reports counts/bytes", () => {
    const cacheDir = scratchDir("prune-delete-");
    mkdirSync(join(cacheDir, "definitions"), { recursive: true });
    const flatFile = join(cacheDir, "definitions", "legacy.json");
    writeFileSync(flatFile, '{"hello":"world"}');

    const refreshDir = join(cacheDir, "definitions", "orb-dev", ".refresh");
    mkdirSync(refreshDir, { recursive: true });
    const lockFile = join(refreshDir, "stale.lock");
    writeFileSync(lockFile, "123456");
    touchAge(lockFile, 20 * 60 * 1000);

    const data = pruneLocalCache(cacheDir, { yes: true });
    expect(data.dryRun).toBe(false);
    expect(data.removed.files).toBe(2);
    expect(data.removed.bytes).toBe('{"hello":"world"}'.length + "123456".length);
    expect(existsSync(flatFile)).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("best-effort: a missing cache dir yields an empty, error-free result", () => {
    const cacheDir = scratchDir("prune-none-");
    rmSync(cacheDir, { recursive: true, force: true });
    const errors: string[] = [];
    const data = pruneLocalCache(cacheDir, { yes: true, onError: m => errors.push(m) });
    expect(data.flatFiles.scanned).toBe(0);
    expect(data.staleLocks.scanned).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("wi-impl cache prune-local (command wiring)", () => {
  // Unique namespace name so this suite never collides with real cache
  // namespaces (methods/pages/definitions/…) that other tests populate in
  // the same shared WI_IMPL_HOME.
  const cacheDir = join(BELZ_CONFIG_DIR, "cache");
  const NS = "wi-impl-test-prune-ns";
  const flatFile = join(cacheDir, NS, "sentinel.json");

  afterAll(() => {
    rmSync(join(cacheDir, NS), { recursive: true, force: true });
  });

  test("parseArgs routes 'prune-local' to its own subcommand", () => {
    const ctx = { outputMode: "llm", env: { name: "t" }, warn: () => {} } as any;
    expect((command.parseArgs as any)(["prune-local"], ctx)).toEqual({ subcommand: "prune-local", yes: false });
    expect((command.parseArgs as any)(["prune-local", "--yes"], ctx)).toEqual({ subcommand: "prune-local", yes: true });
    expect((command.parseArgs as any)(["prune-local", "-y"], ctx)).toEqual({ subcommand: "prune-local", yes: true });
  });

  test("declares writesLocal, and writes(args) is false for prune-local (no explicit --env required)", () => {
    expect(command.writesLocal).toBe(true);
    expect(typeof command.writes).toBe("function");
    const parsed = (command.parseArgs as any)(["prune-local"], {} as any);
    expect((command.writes as (a: unknown) => boolean)(parsed)).toBe(false);
    const invalidateParsed = (command.parseArgs as any)(["44014c3707d6b6d8ae848839a1c8d1e7"], {} as any);
    expect((command.writes as (a: unknown) => boolean)(invalidateParsed)).toBe(true);
  });

  test("dry run over the real dispatch path lists a sentinel flat file without deleting it", async () => {
    mkdirSync(join(cacheDir, NS), { recursive: true });
    writeFileSync(flatFile, '{"sentinel":true}');

    const result = await runCommand(command, ["prune-local"]);
    expect(result.exitCode).toBe(0);
    const data = result.envelope!.data as any;
    expect(data.action).toBe("prune-local");
    expect(data.dryRun).toBe(true);
    expect(data.flatFiles.sample.some((i: any) => i.path === `${NS}/sentinel.json`)).toBe(true);
    expect(existsSync(flatFile)).toBe(true);
  });

  test("--yes deletes the sentinel flat file over the real dispatch path", async () => {
    const result = await runCommand(command, ["prune-local", "--yes"]);
    expect(result.exitCode).toBe(0);
    const data = result.envelope!.data as any;
    expect(data.dryRun).toBe(false);
    expect(existsSync(flatFile)).toBe(false);
  });
});
