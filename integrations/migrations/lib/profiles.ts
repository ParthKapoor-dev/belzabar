import { readFileSync } from "fs";
import { CliError, writeSecureJson } from "@belzabar/core";
import { MIGRATION_PROFILES_CACHE_PATH, type JenkinsClient } from "./constants";
import type { JenkinsAuth } from "@belzabar/jenkins";
import { getJobParameters } from "@belzabar/jenkins";
import type { ProfileResolution, ProfilesByClient } from "./types";

const DIVIDER_RE = /^\s*-{3,}\s*(.+?)\s*-{3,}\s*$/;

function isDivider(choice: string): boolean { return DIVIDER_RE.test(choice); }

function dividerClient(choice: string): JenkinsClient | undefined {
  const match = choice.match(DIVIDER_RE);
  if (!match) return undefined;
  const name = match[1]?.trim();
  return name ? name : undefined;
}

export function groupProfiles(choices: string[]): ProfilesByClient[] {
  const groups: ProfilesByClient[] = [];
  let current: ProfilesByClient | null = null;
  for (const choice of choices) {
    if (isDivider(choice)) {
      const client = dividerClient(choice);
      if (!client) { current = null; continue; }
      current = { client, profiles: [] };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    current.profiles.push(choice);
  }
  return groups.filter((g) => g.profiles.length > 0);
}

interface ProfilesCacheFile {
  fetchedAt: string;
  groups: ProfilesByClient[];
}

/** Cached profile lists older than this are re-fetched from Jenkins (MG-4). */
export const PROFILES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readCache(): ProfilesCacheFile | null {
  try {
    const raw = readFileSync(MIGRATION_PROFILES_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as ProfilesCacheFile;
    return parsed && Array.isArray(parsed.groups) && typeof parsed.fetchedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(value: ProfilesCacheFile): void {
  try {
    writeSecureJson(MIGRATION_PROFILES_CACHE_PATH, value, { pretty: true, mode: 0o644 });
  } catch {
    // Cache write failures shouldn't break the command.
  }
}

function isFresh(cache: ProfilesCacheFile, ttlMs: number, now = Date.now()): boolean {
  const at = Date.parse(cache.fetchedAt);
  return Number.isFinite(at) && now - at < ttlMs;
}

export async function discoverProfiles(
  auth: JenkinsAuth,
  options: { refresh?: boolean; ttlMs?: number } = {}
): Promise<ProfileResolution> {
  if (!options.refresh) {
    const cache = readCache();
    if (cache && isFresh(cache, options.ttlMs ?? PROFILES_CACHE_TTL_MS)) {
      return {
        fetchedAt: cache.fetchedAt,
        source: "cache",
        groups: cache.groups,
        flat: cache.groups.flatMap((g) => g.profiles),
      };
    }
  }

  const params = await getJobParameters(auth);
  const profileParam = params.find((p) => p.name === "PROFILE_NAME");
  if (!profileParam || !Array.isArray(profileParam.choices)) {
    throw new CliError("Jenkins job has no PROFILE_NAME choice parameter.", {
      code: "MIGRATE_JENKINS_NO_PROFILE_PARAM",
      details: { job: auth.job },
    });
  }

  const groups = groupProfiles(profileParam.choices);
  const fetchedAt = new Date().toISOString();
  writeCache({ fetchedAt, groups });
  return {
    fetchedAt,
    source: "live",
    groups,
    flat: groups.flatMap((g) => g.profiles),
  };
}

export function findClientForProfile(groups: ProfilesByClient[], profile: string): JenkinsClient | undefined {
  for (const group of groups) {
    if (group.profiles.includes(profile)) return group.client;
  }
  return undefined;
}

/**
 * Resolve the Jenkins client group of `profile`. A miss against the cached
 * list re-fetches from Jenkins once before giving up (MG-4: a stale cache used
 * to send users to `migrate profiles`, which read the same stale cache).
 */
export async function resolveClientForProfile(
  auth: JenkinsAuth,
  profile: string,
): Promise<{ client: JenkinsClient | undefined; resolution: ProfileResolution }> {
  let resolution = await discoverProfiles(auth);
  let client = findClientForProfile(resolution.groups, profile);
  if (!client && resolution.source === "cache") {
    resolution = await discoverProfiles(auth, { refresh: true });
    client = findClientForProfile(resolution.groups, profile);
  }
  return { client, resolution };
}
