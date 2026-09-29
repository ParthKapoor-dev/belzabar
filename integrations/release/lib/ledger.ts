// Promotion ledger — persistent record of release audits under ~/.belz/.
//
// `belz release matrix` writes its computed audit here so it accumulates
// release-over-release; `belz release freeze` writes a prod snapshot (prod is
// not queryable, so its state is captured from stage at release-push time).
//
// RL-4: writes are atomic (tmp + rename via core writeSecureJson); an
// unreadable or malformed record is LEDGER_CORRUPT (never UNHANDLED); a name
// with no letters/digits is INVALID_RELEASE_NAME; two names that slug to the
// same file are LEDGER_NAME_COLLISION; a snapshot is only replaced with --force.

import { join } from "path";
import { existsSync } from "fs";
import { z } from "zod";
import { BELZ_CONFIG_DIR, CliError, readJsonInputSync, writeSecureJson } from "@belzabar/core";

const PROMOTION_DIR = join(BELZ_CONFIG_DIR, "promotion");
const RELEASES_DIR = join(PROMOTION_DIR, "releases");
const SNAPSHOTS_DIR = join(PROMOTION_DIR, "prod-snapshots");

/** The ledger isn't secret: world-readable like the other ~/.belz caches. */
const LEDGER_MODE = 0o644;

export interface ProdSnapshotItem {
  uuid: string;
  name: string;
  /** Spine position the item occupied on stage when the release was frozen (-1: not on stage / unknown). */
  spinePos: number;
  spineVersion: number | null;
  /** The stage cell's trace status, or "unknown" when stage wasn't traced for this item. */
  stageStatus: string;
  hash: string | null;
}

export interface ProdSnapshot {
  release: string;
  frozenAt: string;
  /** Env the snapshot was captured from (prod is inferred from this). */
  capturedFrom: string;
  items: ProdSnapshotItem[];
  /** Items with no usable stage data (their spinePos is -1 and stageStatus "unknown"). */
  warnings: string[];
}

/** The slice of a saved `release matrix` record that readers rely on. */
const SavedReleaseSchema = z
  .object({
    name: z.string(),
    stageEnv: z.string(),
    items: z.array(
      z
        .object({
          uuid: z.string(),
          name: z.string(),
          envs: z.array(
            z
              .object({
                env: z.string(),
                status: z.string(),
                spinePos: z.number(),
                spineVersion: z.number().nullable(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type SavedRelease = z.infer<typeof SavedReleaseSchema>;

/** File-name slug of a release name. Empty (e.g. "!!!") → INVALID_RELEASE_NAME. */
export function releaseSlug(name: string, opts: { throwOnEmpty?: boolean } = {}): string {
  const s = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!s && opts.throwOnEmpty !== false) {
    throw new CliError(`Invalid release name '${name}': it needs at least one letter or digit.`, {
      code: "INVALID_RELEASE_NAME",
      details: { name },
    });
  }
  return s;
}

export function releasePath(name: string): string {
  return join(RELEASES_DIR, `${releaseSlug(name)}.json`);
}

export function snapshotPath(name: string): string {
  return join(SNAPSHOTS_DIR, `${releaseSlug(name)}.json`);
}

function corrupt(path: string, why: string): CliError {
  return new CliError(
    `Ledger file ${path} is corrupt (${why}). Re-run 'belz release matrix' to rebuild it, or delete the file.`,
    { code: "LEDGER_CORRUPT", details: { path, why } },
  );
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return readJsonInputSync(path, {
    unreadable: (e) => corrupt(path, e instanceof Error ? e.message : String(e)),
    invalid: (e) => corrupt(path, `not valid JSON: ${e instanceof Error ? e.message : e}`),
  });
}

/** A saved matrix record, validated; null when there is none. LEDGER_CORRUPT when unreadable. */
export function loadRelease(name: string): SavedRelease | null {
  const path = releasePath(name);
  const raw = readJson(path);
  if (raw === null) return null;
  const parsed = SavedReleaseSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw corrupt(path, `${first?.path.join(".") || "(root)"}: ${first?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/**
 * Refuse a release name whose slug already holds ANOTHER release's record
 * ("May 12" vs "may-12"). A corrupt record may be overwritten (matrix rebuilds it).
 * Call before doing any network work.
 */
export function assertReleaseSlotFree(name: string): void {
  const path = releasePath(name);
  let existing: unknown;
  try {
    existing = readJson(path);
  } catch {
    return; // corrupt: matrix will replace it
  }
  const existingName =
    existing && typeof existing === "object" && typeof (existing as { name?: unknown }).name === "string"
      ? (existing as { name: string }).name
      : null;
  if (existingName !== null && existingName !== name) {
    throw new CliError(
      `Release name '${name}' maps to ${path}, which holds release '${existingName}'. Pick a distinct name.`,
      { code: "LEDGER_NAME_COLLISION", details: { name, existing: existingName, path } },
    );
  }
}

/** Persist a `belz release matrix` result (atomic). Returns the file path written. */
export function saveRelease(name: string, data: unknown): string {
  assertReleaseSlotFree(name);
  const path = releasePath(name);
  writeSecureJson(path, data, { pretty: true, mode: LEDGER_MODE });
  return path;
}

/**
 * Persist a prod snapshot (atomic). An existing snapshot is SNAPSHOT_EXISTS
 * unless `force` — re-freezing after stage moved on would rewrite history.
 */
export function saveProdSnapshot(snapshot: ProdSnapshot, opts: { force?: boolean } = {}): string {
  const path = snapshotPath(snapshot.release);
  if (existsSync(path) && !opts.force) {
    throw new CliError(
      `A prod snapshot for '${snapshot.release}' already exists (${path}). Pass --force to replace it.`,
      { code: "SNAPSHOT_EXISTS", details: { path } },
    );
  }
  writeSecureJson(path, snapshot, { pretty: true, mode: LEDGER_MODE });
  return path;
}

export { PROMOTION_DIR, RELEASES_DIR, SNAPSHOTS_DIR };
