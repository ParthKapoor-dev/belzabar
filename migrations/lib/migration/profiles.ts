import { mkdirSync } from "fs";
import { dirname } from "path";
import {
  DB_MIGRATION_TOOL_BASE_URL,
  NSM_FALLBACK_PROFILES,
  NSM_PROFILE_CACHE_PATH,
  NSM_PROFILE_CACHE_TTL_MS,
} from "./constants";
import type { NsmProfileResolution } from "./types";

interface ProfileCacheShape {
  fetchedAt: string;
  profiles: string[];
}

interface DiscoverProfilesOptions {
  refresh?: boolean;
  fetchFn?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

const PROFILE_PATTERN = /\b[a-z0-9]+ncdns_[a-z0-9]+ncdns\b/gi;

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

async function readProfileCache(): Promise<ProfileCacheShape | null> {
  try {
    const file = Bun.file(NSM_PROFILE_CACHE_PATH);
    if (!(await file.exists())) return null;
    const parsed = (await file.json()) as ProfileCacheShape;
    if (!parsed || !Array.isArray(parsed.profiles) || typeof parsed.fetchedAt !== "string") {
      return null;
    }

    return {
      fetchedAt: parsed.fetchedAt,
      profiles: normalizeProfiles(parsed.profiles),
    };
  } catch {
    return null;
  }
}

async function writeProfileCache(data: ProfileCacheShape): Promise<void> {
  try {
    mkdirSync(dirname(NSM_PROFILE_CACHE_PATH), { recursive: true });
    await Bun.write(NSM_PROFILE_CACHE_PATH, JSON.stringify(data, null, 2));
  } catch {
    // Cache persistence is best-effort and should not fail command execution.
  }
}

function buildCacheResolution(cache: ProfileCacheShape, raw?: NsmProfileResolution["raw"]): NsmProfileResolution {
  return {
    profiles: cache.profiles,
    source: "cache",
    fetchedAt: cache.fetchedAt,
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

  const normalizedProfiles = normalizeProfiles(matchedProfiles);
  if (normalizedProfiles.length === 0) {
    throw new Error(`No NSM profiles discovered from live assets. ${errors.join(" | ")}`);
  }

  const fetchedAt = new Date().toISOString();
  await writeProfileCache({
    fetchedAt,
    profiles: normalizedProfiles,
  });

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
  const ttlMs = options.ttlMs ?? NSM_PROFILE_CACHE_TTL_MS;
  const now = options.now ? options.now() : Date.now();

  const cached = await readProfileCache();
  if (!options.refresh && cached) {
    const cachedAt = Date.parse(cached.fetchedAt);
    if (Number.isFinite(cachedAt) && now - cachedAt < ttlMs) {
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
    if (cached && cached.profiles.length > 0) {
      return buildCacheResolution(cached, {
        scannedUrls: [],
        matchedProfiles: cached.profiles,
        errors: [error instanceof Error ? error.message : String(error)],
        cachePath: NSM_PROFILE_CACHE_PATH,
      });
    }

    return {
      profiles: [...NSM_FALLBACK_PROFILES],
      source: "fallback",
      fetchedAt: new Date(now).toISOString(),
      raw: {
        scannedUrls: [],
        matchedProfiles: [...NSM_FALLBACK_PROFILES],
        errors: [error instanceof Error ? error.message : String(error)],
        cachePath: NSM_PROFILE_CACHE_PATH,
      },
    };
  }
}
