import { mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { dirname } from "path";
import { CliError } from "@belzabar/core";
import { JENKINS_CLIENTS, MIGRATION_PROFILES_CACHE_PATH, type JenkinsClient } from "./constants";
import type { JenkinsAuth } from "./jenkins/auth";
import { getJobParameters } from "./jenkins/client";
import type { ProfileResolution, ProfilesByClient } from "./types";

const DIVIDER_RE = /^\s*-{3,}\s*(.+?)\s*-{3,}\s*$/;

function isDivider(choice: string): boolean { return DIVIDER_RE.test(choice); }

function dividerClient(choice: string): JenkinsClient | undefined {
  const match = choice.match(DIVIDER_RE);
  if (!match) return undefined;
  const name = match[1]?.trim();
  return JENKINS_CLIENTS.find((c) => c === name);
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

function readCache(): ProfilesCacheFile | null {
  try {
    statSync(MIGRATION_PROFILES_CACHE_PATH);
    const raw = readFileSync(MIGRATION_PROFILES_CACHE_PATH, "utf-8");
    return JSON.parse(raw) as ProfilesCacheFile;
  } catch {
    return null;
  }
}

function writeCache(value: ProfilesCacheFile): void {
  try {
    mkdirSync(dirname(MIGRATION_PROFILES_CACHE_PATH), { recursive: true });
    writeFileSync(MIGRATION_PROFILES_CACHE_PATH, JSON.stringify(value, null, 2));
  } catch {
    // Cache write failures shouldn't break the command.
  }
}

export async function discoverProfiles(
  auth: JenkinsAuth,
  options: { refresh?: boolean } = {}
): Promise<ProfileResolution> {
  if (!options.refresh) {
    const cache = readCache();
    if (cache) {
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
