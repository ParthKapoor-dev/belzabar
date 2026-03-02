import { join } from "path";
import { Cache, BELZ_CONFIG_DIR } from "@belzabar/core";
import {
  DB_MIGRATION_TOOL_BASE_URL,
  NSM_FALLBACK_PROFILES,
  NSM_PROFILE_CACHE_PATH,
} from "./constants";
import type { NsmProfileResolution } from "./types";

interface ProfileCacheData {
  fetchedAt: string;
  profiles: string[];
}

interface DiscoverProfilesOptions {
  refresh?: boolean;
  fetchFn?: typeof fetch;
}

const PROFILE_PATTERN = /\b[a-z0-9]+ncdns_[a-z0-9]+ncdns\b/gi;

const profileCache = new Cache<ProfileCacheData>({
  dir: join(BELZ_CONFIG_DIR, "migrations"),
  ttlMs: null,
});

const CACHE_KEY = "nsm-profiles";

function normalizeProfiles(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractScriptUrls(html: string, baseUrl: string): string[] {
  const matches = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi));
  const urls = matches
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      try {
        return new URL(value, baseUrl).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  return normalizeProfiles(urls);
}

export function extractProfilesFromText(text: string): string[] {
  const matches = text.match(PROFILE_PATTERN) || [];
  return normalizeProfiles(matches);
}

function buildCacheResolution(cached: ProfileCacheData, raw?: NsmProfileResolution["raw"]): NsmProfileResolution {
  return {
    profiles: cached.profiles,
    source: "cache",
    fetchedAt: cached.fetchedAt,
    raw,
  };
}

async function discoverProfilesLive(fetchFn: typeof fetch): Promise<NsmProfileResolution> {
  const scannedUrls: string[] = [];
  const errors: string[] = [];
  const matchedProfiles: string[] = [];

  const addMatches = (source: string, text: string) => {
    scannedUrls.push(source);
    matchedProfiles.push(...extractProfilesFromText(text));
  };

  const indexUrl = `${DB_MIGRATION_TOOL_BASE_URL}/index.html#/NCDNS%3A%20Migrate%20Source%20DB%20to%20Target%20DB`;
  let htmlText = "";

  try {
    const htmlResp = await fetchFn(indexUrl);
    htmlText = await htmlResp.text();
    addMatches(indexUrl, htmlText);
  } catch (error) {
    errors.push(`index fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const jsUrls = extractScriptUrls(htmlText, DB_MIGRATION_TOOL_BASE_URL);
  for (const jsUrl of jsUrls) {
    try {
      const scriptResp = await fetchFn(jsUrl);
      const scriptText = await scriptResp.text();
      addMatches(jsUrl, scriptText);
    } catch (error) {
      errors.push(`script fetch failed (${jsUrl}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const discovered = normalizeProfiles(matchedProfiles);
  if (discovered.length === 0) {
    throw new Error(`No NSM profiles discovered from live assets. ${errors.join(" | ")}`);
  }

  // Merge with fallback so cache always contains at least the known set.
  const normalizedProfiles = normalizeProfiles([...discovered, ...NSM_FALLBACK_PROFILES]);

  const fetchedAt = new Date().toISOString();
  await profileCache.save(CACHE_KEY, { fetchedAt, profiles: normalizedProfiles });

  return {
    profiles: normalizedProfiles,
    source: "live",
    fetchedAt,
    raw: {
      scannedUrls,
      matchedProfiles: normalizedProfiles,
      errors,
      cachePath: NSM_PROFILE_CACHE_PATH,
    },
  };
}

export async function discoverNsmProfiles(options: DiscoverProfilesOptions = {}): Promise<NsmProfileResolution> {
  const fetchFn = options.fetchFn || fetch;

  if (!options.refresh) {
    const cached = await profileCache.load(CACHE_KEY);
    if (cached) {
      return buildCacheResolution(cached, {
        scannedUrls: [],
        matchedProfiles: cached.profiles,
        errors: [],
        cachePath: NSM_PROFILE_CACHE_PATH,
      });
    }
  }

  try {
    return await discoverProfilesLive(fetchFn);
  } catch (error) {
    // On live failure, fall back to cache merged with hardcoded fallback (best available set).
    const cached = await profileCache.load(CACHE_KEY);
    const mergedProfiles = normalizeProfiles([
      ...(cached?.profiles ?? []),
      ...NSM_FALLBACK_PROFILES,
    ]);

    if (cached) {
      return buildCacheResolution({ ...cached, profiles: mergedProfiles }, {
        scannedUrls: [],
        matchedProfiles: mergedProfiles,
        errors: [error instanceof Error ? error.message : String(error)],
        cachePath: NSM_PROFILE_CACHE_PATH,
      });
    }

    return {
      profiles: mergedProfiles,
      source: "fallback",
      fetchedAt: new Date().toISOString(),
      raw: {
        scannedUrls: [],
        matchedProfiles: mergedProfiles,
        errors: [error instanceof Error ? error.message : String(error)],
        cachePath: NSM_PROFILE_CACHE_PATH,
      },
    };
  }
}
