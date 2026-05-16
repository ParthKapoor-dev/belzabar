// Promotion ledger — persistent record of release audits under ~/.belz/.
//
// `belz release matrix` writes its computed audit here so it accumulates
// release-over-release; `belz release freeze` writes a prod snapshot (prod is
// not queryable, so its state is captured from stage at release-push time).

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { BELZ_CONFIG_DIR } from "@belzabar/core";

const PROMOTION_DIR = join(BELZ_CONFIG_DIR, "promotion");
const RELEASES_DIR = join(PROMOTION_DIR, "releases");
const SNAPSHOTS_DIR = join(PROMOTION_DIR, "prod-snapshots");

export interface ProdSnapshotItem {
  uuid: string;
  name: string;
  /** Spine position the item occupied on stage when the release was frozen. */
  spinePos: number;
  spineVersion: number | null;
  hash: string | null;
}

export interface ProdSnapshot {
  release: string;
  frozenAt: string;
  /** Env the snapshot was captured from (prod is inferred from this). */
  capturedFrom: string;
  items: ProdSnapshotItem[];
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Persist a `belz release matrix` result. Returns the file path written. */
export function saveRelease(name: string, data: unknown): string {
  ensureDir(RELEASES_DIR);
  const path = join(RELEASES_DIR, `${slug(name)}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

export function loadRelease<T = unknown>(name: string): T | null {
  const path = join(RELEASES_DIR, `${slug(name)}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function listReleases(): string[] {
  if (!existsSync(RELEASES_DIR)) return [];
  return readdirSync(RELEASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** Persist a prod snapshot frozen from stage. Returns the file path written. */
export function saveProdSnapshot(snapshot: ProdSnapshot): string {
  ensureDir(SNAPSHOTS_DIR);
  const path = join(SNAPSHOTS_DIR, `${slug(snapshot.release)}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return path;
}

export function loadProdSnapshot(name: string): ProdSnapshot | null {
  const path = join(SNAPSHOTS_DIR, `${slug(name)}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ProdSnapshot;
}

export { PROMOTION_DIR, RELEASES_DIR, SNAPSHOTS_DIR };
