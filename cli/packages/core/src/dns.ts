import { lookup } from "dns/promises";
import { vlog } from "./verbose";

interface CacheEntry {
  ip: string;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 5 * 60 * 1000;

async function resolveIPv4(host: string): Promise<string> {
  const now = Date.now();
  const hit = cache.get(host);
  if (hit && hit.expires > now) {
    vlog(`DNS HIT ${host} → ${hit.ip}`);
    return hit.ip;
  }
  const { address } = await lookup(host, { family: 4 });
  cache.set(host, { ip: address, expires: now + TTL_MS });
  vlog(`DNS RESOLVE ${host} → ${address}`);
  return address;
}

export interface Ipv4FetchPrep {
  url: string;
  init: RequestInit & { tls?: { serverName: string } };
}

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
  const ip = await resolveIPv4(host);
  u.hostname = ip;
  const headers = new Headers(init.headers);
  headers.set("Host", host);
  return {
    url: u.toString(),
    init: { ...init, headers, tls: { serverName: host } },
  };
}
