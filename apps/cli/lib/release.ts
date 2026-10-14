// What a wi-impl release is: versions, platform targets, the release manifest, and downloading a
// verified asset. Shared by `wi-impl update` (binary installs), the background auto-update
// (./auto-update.ts) and the release build (apps/cli/scripts/build-release.ts).

import { createHash } from "crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "fs";
import { z } from "zod";
import { CliError, trustedBelzEnv } from "@belzabar/core";

/** Public GitHub Releases of the belzabar repo. `WI_IMPL_UPDATE_BASE_URL` overrides it (mirrors, tests). */
const DEFAULT_RELEASES_URL = "https://github.com/ParthKapoor-dev/belzabar/releases";

function releasesBaseUrl(): string {
  return (trustedBelzEnv().WI_IMPL_UPDATE_BASE_URL || DEFAULT_RELEASES_URL).replace(/\/+$/, "");
}

/** Every platform a release ships a binary for (`bun build --compile --target=bun-<target>`). */
export const RELEASE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

/** Release asset file name for a target: `wi-impl-linux-x64`, `wi-impl-windows-x64.exe`. */
export function assetName(target: ReleaseTarget): string {
  return `wi-impl-${target}${target.startsWith("windows") ? ".exe" : ""}`;
}

/** The target of the running process, or null on a platform no release ships. */
export function currentTarget(platform: string = process.platform, arch: string = process.arch): ReleaseTarget | null {
  const os = platform === "win32" ? "windows" : platform;
  const t = `${os}-${arch}`;
  return (RELEASE_TARGETS as readonly string[]).includes(t) ? (t as ReleaseTarget) : null;
}

// ── versions ─────────────────────────────────────────────────────────────────

/** `major.minor.patch` (a leading `v` is accepted); null when it is not one. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1; an unparseable version sorts below every real one. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return 0;
}

/** Auto-update only moves within a major version; a new major waits for `wi-impl update`. */
export function sameMajor(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return !!pa && !!pb && pa[0] === pb[0];
}

// ── manifest ─────────────────────────────────────────────────────────────────

const ManifestSchema = z.object({
  version: z.string().refine((v) => parseVersion(v) !== null, "not a major.minor.patch version"),
  sha: z.string(),
  publishedAt: z.string(),
  assets: z.record(z.object({ name: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});
export type ReleaseManifest = z.infer<typeof ManifestSchema>;

/** `manifest.json` of the latest release, or of `v<version>` when given. */
export function manifestUrl(version?: string): string {
  const base = releasesBaseUrl();
  return version ? `${base}/download/v${version.replace(/^v/, "")}/manifest.json` : `${base}/latest/download/manifest.json`;
}

function assetUrl(version: string, name: string): string {
  return `${releasesBaseUrl()}/download/v${version}/${name}`;
}

async function get(url: string, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new CliError(`Could not reach ${url}: ${(e as Error).message}`, { code: "UPDATE_NETWORK_ERROR" });
  }
  if (!res.ok) {
    throw new CliError(`${url} answered HTTP ${res.status}.`, {
      code: res.status === 404 ? "UPDATE_RELEASE_NOT_FOUND" : "UPDATE_HTTP_ERROR",
      details: { url, status: res.status },
    });
  }
  return res;
}

export async function fetchManifest(version?: string, timeoutMs = 10_000): Promise<ReleaseManifest> {
  const url = manifestUrl(version);
  const res = await get(url, timeoutMs);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CliError(`${url} is not JSON.`, { code: "UPDATE_BAD_MANIFEST" });
  }
  const parsed = ManifestSchema.safeParse(body);
  if (!parsed.success) {
    throw new CliError(`${url} is not a wi-impl release manifest: ${parsed.error.issues[0]?.message ?? "invalid"}`, {
      code: "UPDATE_BAD_MANIFEST",
    });
  }
  return parsed.data;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Download this platform's binary of `manifest` to `dest`: written to a temp file next to it,
 * checked against the manifest's sha256, made executable, then renamed into place, so `dest`
 * is either absent or a complete, verified binary.
 */
export async function downloadVerifiedAsset(manifest: ReleaseManifest, dest: string, timeoutMs = 300_000): Promise<void> {
  const target = currentTarget();
  if (!target) {
    throw new CliError(`No wi-impl release is built for ${process.platform}-${process.arch}.`, { code: "UPDATE_UNSUPPORTED_PLATFORM" });
  }
  const asset = manifest.assets[target];
  if (!asset) {
    throw new CliError(`Release v${manifest.version} has no ${target} binary.`, { code: "UPDATE_ASSET_MISSING" });
  }
  const res = await get(assetUrl(manifest.version, asset.name), timeoutMs);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== asset.sha256) {
    throw new CliError(`Checksum mismatch for ${asset.name} v${manifest.version}: the download was not used.`, {
      code: "UPDATE_CHECKSUM_MISMATCH",
      details: { expected: asset.sha256, actual },
    });
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
