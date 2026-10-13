// The release library and the binary self-update: versions, targets, manifest + verified
// download (against a local fake release server), the auto-update gate, swap and rollback.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BELZ_CONFIG_DIR, type BelzConfigFile } from "@belzabar/core";
import { autoUpdateBlocker, installKind, rollbackBinary, swapInBinary, updateHint } from "../lib/auto-update";
import {
  assetName,
  compareVersions,
  currentTarget,
  downloadVerifiedAsset,
  fetchManifest,
  manifestUrl,
  sameMajor,
  sha256Hex,
  type ReleaseManifest,
} from "../lib/release";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "belz-selfupd-"));
  dirs.push(d);
  return d;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("versions and targets", () => {
  test("compareVersions orders major.minor.patch numerically", () => {
    expect(compareVersions("0.2.0", "0.10.0")).toBe(-1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("garbage", "0.0.1")).toBe(-1);
  });
  test("sameMajor gates auto-update", () => {
    expect(sameMajor("0.2.0", "0.9.1")).toBe(true);
    expect(sameMajor("1.0.0", "2.0.0")).toBe(false);
  });
  test("targets map to release asset names", () => {
    expect(currentTarget("linux", "x64")).toBe("linux-x64");
    expect(currentTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentTarget("win32", "x64")).toBe("windows-x64");
    expect(currentTarget("freebsd", "x64")).toBeNull();
    expect(assetName("windows-x64")).toBe("belz-windows-x64.exe");
    expect(assetName("linux-arm64")).toBe("belz-linux-arm64");
  });
});

describe("updateHint (unknown command/flag)", () => {
  const statePath = join(BELZ_CONFIG_DIR, "update-state.json");
  const build = { version: "0.2.3", dirty: false };
  const now = 1_800_000_000_000;
  const withState = (s: object) => writeFileSync(statePath, JSON.stringify(s));
  afterAll(() => rmSync(statePath, { force: true }));

  test("names a newer release the last check found", () => {
    withState({ lastCheckAt: now - 1000, latestVersion: "0.2.4" });
    expect(updateHint(build, now)).toContain("belz 0.2.4 is available");
  });

  test("says nothing when a recent check found this version current", () => {
    withState({ lastCheckAt: now - 1000, latestVersion: "0.2.3" });
    expect(updateHint(build, now)).toBeNull();
  });

  test("points at `belz update --check` when nothing recent is known", () => {
    withState({});
    expect(updateHint(build, now)).toContain("belz update --check");
    withState({ lastCheckAt: now - 2 * 24 * 3600 * 1000, latestVersion: "0.2.3" });
    expect(updateHint(build, now)).toContain("belz update --check");
  });
});

describe("autoUpdateBlocker", () => {
  const compiled = ["bun", "/$bunfs/root/belz"];
  const binary: BelzConfigFile = { belz: { installKind: "binary" } };
  const build = { version: "0.2.0", dirty: false };
  const gate = (over: { argv?: string[]; env?: NodeJS.ProcessEnv; config?: BelzConfigFile; dirty?: boolean } = {}) =>
    autoUpdateBlocker({ ...build, dirty: over.dirty ?? false }, {
      argv: over.argv ?? compiled,
      env: over.env ?? {},
      config: over.config ?? binary,
    });

  test("a clean compiled binary install may auto-update", () => {
    expect(gate()).toBeNull();
  });
  test("every opt-out blocks it", () => {
    expect(gate({ argv: ["bun", "/repo/apps/cli/bin/cli.ts"] })).toContain("not a compiled");
    expect(gate({ dirty: true })).toContain("uncommitted");
    expect(gate({ env: { CI: "true" } })).toContain("CI");
    expect(gate({ env: { BELZ_NO_UPDATE: "1" } })).toContain("BELZ_NO_UPDATE");
    expect(gate({ config: { ...binary, update: { auto: false } } })).toContain("update.auto");
    expect(gate({ config: { ...binary, update: { pin: "0.2.0" } } })).toContain("pinned");
    expect(gate({ config: { belz: { installKind: "source" } } })).toContain("source install");
    expect(gate({ config: {} })).toContain("source install");
  });
  test("only an explicitly recorded binary install counts as binary", () => {
    expect(installKind({ belz: { installKind: "binary" } })).toBe("binary");
    expect(installKind({ belz: { sourceDir: "/x" } })).toBe("source");
    expect(installKind({})).toBe("source");
  });
});

describe("fetchManifest + downloadVerifiedAsset (fake release server)", () => {
  const payload = new TextEncoder().encode("#!/bin/sh\necho new-belz\n");
  const target = currentTarget()!;
  let server: ReturnType<typeof Bun.serve>;
  let manifest: ReleaseManifest;
  let tamper = false;
  const savedBase = process.env.BELZ_UPDATE_BASE_URL;

  beforeAll(() => {
    manifest = {
      version: "9.9.9",
      sha: "abc1234",
      publishedAt: "2026-01-01T00:00:00Z",
      assets: { [target]: { name: assetName(target), sha256: sha256Hex(payload) } },
    };
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/releases/latest/download/manifest.json" || path === "/releases/download/v9.9.9/manifest.json") {
          return Response.json(manifest);
        }
        if (path === `/releases/download/v9.9.9/${assetName(target)}`) {
          return new Response(tamper ? new TextEncoder().encode("evil") : payload);
        }
        return new Response("nope", { status: 404 });
      },
    });
    process.env.BELZ_UPDATE_BASE_URL = `http://localhost:${server.port}/releases/`;
  });
  afterAll(() => {
    server.stop(true);
    if (savedBase === undefined) delete process.env.BELZ_UPDATE_BASE_URL;
    else process.env.BELZ_UPDATE_BASE_URL = savedBase;
  });

  test("manifest URLs: latest and pinned", () => {
    expect(manifestUrl()).toBe(`http://localhost:${server.port}/releases/latest/download/manifest.json`);
    expect(manifestUrl("v1.2.3")).toBe(`http://localhost:${server.port}/releases/download/v1.2.3/manifest.json`);
  });

  test("reads and validates the manifest; a missing release is UPDATE_RELEASE_NOT_FOUND", async () => {
    expect((await fetchManifest()).version).toBe("9.9.9");
    expect((await fetchManifest("9.9.9")).version).toBe("9.9.9");
    await expect(fetchManifest("1.0.0")).rejects.toMatchObject({ code: "UPDATE_RELEASE_NOT_FOUND" });
  });

  test("a verified download lands executable at dest", async () => {
    const dest = join(tmp(), "belz.next");
    await downloadVerifiedAsset(manifest, dest);
    expect(readFileSync(dest)).toEqual(Buffer.from(payload));
  });

  test("a checksum mismatch is refused and leaves nothing behind", async () => {
    const dir = tmp();
    const dest = join(dir, "belz.next");
    tamper = true;
    try {
      await expect(downloadVerifiedAsset(manifest, dest)).rejects.toMatchObject({ code: "UPDATE_CHECKSUM_MISMATCH" });
    } finally {
      tamper = false;
    }
    expect(existsSync(dest)).toBe(false);
  });
});

describe("swapInBinary / rollbackBinary", () => {
  test("swap keeps the old binary as .prev; rollback swaps them back", () => {
    const dir = tmp();
    const exe = join(dir, "belz");
    writeFileSync(exe, "old");
    writeFileSync(`${exe}.next`, "new");
    swapInBinary(exe, `${exe}.next`);
    expect(readFileSync(exe, "utf8")).toBe("new");
    expect(readFileSync(`${exe}.prev`, "utf8")).toBe("old");
    expect(existsSync(`${exe}.next`)).toBe(false);
    rollbackBinary(exe);
    expect(readFileSync(exe, "utf8")).toBe("old");
    expect(readFileSync(`${exe}.prev`, "utf8")).toBe("new");
  });
  test("rollback without a previous binary throws and changes nothing", () => {
    const dir = tmp();
    const exe = join(dir, "belz");
    writeFileSync(exe, "only");
    expect(() => rollbackBinary(exe)).toThrow("no previous binary");
    expect(readFileSync(exe, "utf8")).toBe("only");
  });
});
