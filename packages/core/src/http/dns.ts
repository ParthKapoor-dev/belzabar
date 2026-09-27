import { lookup, resolve4 } from "dns/promises";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "../config";
import { vlog } from "../verbose";

interface CacheEntry {
  ip: string;
  expires: number;
}

const memCache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

// The CLI is a short-lived process: an in-memory map alone never survives to the
// next invocation, so every command would re-query DNS. Persist to disk so the
// TTL is actually worth something.
const CACHE_DIR = join(BELZ_CONFIG_DIR, "cache");
const DISK_CACHE_PATH = join(CACHE_DIR, "dns.json");

const ATTEMPTS = 4;
const BACKOFF_MS = 150;

function readDiskCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(DISK_CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function loadCached(host: string): string | null {
  const now = Date.now();

  const mem = memCache.get(host);
  if (mem && mem.expires > now) return mem.ip;

  const entry = readDiskCache()[host];
  if (entry && entry.expires > now) {
    memCache.set(host, entry);
    return entry.ip;
  }
  return null;
}

function storeCached(host: string, ip: string): void {
  const entry: CacheEntry = { ip, expires: Date.now() + TTL_MS };
  memCache.set(host, entry);
  try {
    const all = readDiskCache();
    all[host] = entry;
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(DISK_CACHE_PATH, JSON.stringify(all));
  } catch (err) {
    // A cache write failure must never fail the request.
    vlog(`DNS cache write failed for ${host}`, { error: String(err) });
  }
}

/**
 * Drop `host`'s pinned IPv4 (memory + disk). Called when a request to the
 * pinned IP fails to connect, so a load balancer IP change is picked up at
 * once instead of after the 5-minute TTL (CORE-20).
 */
export function evictIpv4Cache(host: string): void {
  memCache.delete(host);
  try {
    const all = readDiskCache();
    if (!(host in all)) return;
    delete all[host];
    writeFileSync(DISK_CACHE_PATH, JSON.stringify(all));
    vlog(`DNS EVICT ${host}`);
  } catch (err) {
    vlog(`DNS evict failed for ${host}`, { error: String(err) });
  }
}

/**
 * Resolve an A record, retrying across both resolver paths.
 *
 * We need IPv4 specifically (see prepareIpv4Fetch), but an A-only query is the
 * exact thing a flaky upstream resolver is most likely to REFUSE or time out on
 * while still answering AAAA — so a single attempt is not good enough. resolve4()
 * queries via c-ares; lookup() goes through getaddrinfo. They fail independently,
 * so try both before giving up.
 */
export type Ipv4Resolver = (host: string) => string | Promise<string>;
let resolverOverride: Ipv4Resolver | null = null;

/**
 * Test seam: replace DNS resolution (and bypass the DNS cache) with `resolver`.
 * Pass `null` to restore real resolution. Used by core/testing `fakeFetch` so
 * the IPv4 pinning path runs without touching the network.
 */
export function setIpv4ResolverForTesting(resolver: Ipv4Resolver | null): void {
  resolverOverride = resolver;
}

async function resolveIPv4(host: string): Promise<string> {
  if (resolverOverride) return await resolverOverride(host);
  const cached = loadCached(host);
  if (cached) {
    vlog(`DNS HIT ${host} → ${cached}`);
    return cached;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const [address] = await resolve4(host);
      if (address) {
        storeCached(host, address);
        vlog(`DNS RESOLVE ${host} → ${address} (resolve4, attempt ${attempt + 1})`);
        return address;
      }
    } catch (err) {
      lastError = err;
    }

    try {
      const { address } = await lookup(host, { family: 4 });
      storeCached(host, address);
      vlog(`DNS RESOLVE ${host} → ${address} (lookup, attempt ${attempt + 1})`);
      return address;
    } catch (err) {
      lastError = err;
    }

    if (attempt < ATTEMPTS - 1) {
      await new Promise(resolve => setTimeout(resolve, BACKOFF_MS * (attempt + 1)));
    }
  }

  throw lastError ?? new Error(`Could not resolve an IPv4 address for ${host}`);
}

export interface Ipv4FetchPrep {
  url: string;
  init: RequestInit & { tls?: { serverName: string } };
  /** The hostname whose IP was substituted, when the request was pinned. */
  pinnedHost?: string;
}

/**
 * Rewrite a fetch to hit the host's IPv4 address directly.
 *
 * Bun's fetch does not implement happy-eyeballs, so when a host advertises AAAA
 * that black-holes, requests hang on a SYN that never completes. Pinning to IPv4
 * (preserving Host + TLS SNI) dodges that.
 *
 * If resolution fails entirely we hand back the original URL rather than throwing:
 * a request that might hang is still better than a command that cannot run at all,
 * and callers have no fallback of their own.
 */
export async function prepareIpv4Fetch(
  originalUrl: string,
  init: RequestInit = {}
): Promise<Ipv4FetchPrep> {
  const u = new URL(originalUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { url: originalUrl, init };
  }
  const host = u.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return { url: originalUrl, init };
  }

  let ip: string;
  try {
    ip = await resolveIPv4(host);
  } catch (err) {
    vlog(`DNS FAILED ${host} — falling back to hostname`, { error: String(err) });
    return { url: originalUrl, init };
  }

  u.hostname = ip;
  const headers = new Headers(init.headers);
  headers.set("Host", host);
  return {
    url: u.toString(),
    init: { ...init, headers, tls: { serverName: host } },
    pinnedHost: host,
  };
}
