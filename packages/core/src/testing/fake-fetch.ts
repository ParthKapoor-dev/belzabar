// fakeFetch: a routed stand-in for globalThis.fetch.
//
//   const ff = fakeFetch({
//     "GET /rest/api/automation/chain/*": fixture("tests/fixtures/chain.json"),
//     "POST /do/login": { token: "t" },
//     "GET https://x.test/a?b=1": (req) => new Response("hi"),
//   }).install();
//   ... run code that calls fetch / apiFetch ...
//   ff.requests;   // every request, in order
//   ff.restore();
//
// Routes match on method and URL. A string pattern matches the full URL or its
// path+query; `*` is a wildcard. A RegExp is tested against the full URL.
// An unmatched request throws (the calling code sees a rejected fetch).
//
// install() also stubs DNS (core/dns.ts) so apiFetch's IPv4 pinning runs
// without the network; requests pinned to the fake IP are mapped back to their
// logical URL via the Host header before matching.

import { readFileSync } from "fs";
import { setIpv4ResolverForTesting } from "../http/dns";

export interface RecordedRequest {
  method: string;
  /** Logical URL (hostname restored when the request was IPv4-pinned). */
  url: string;
  /** URL actually passed to fetch. */
  wireUrl: string;
  headers: Record<string, string>;
  body: string | null;
  /** `JSON.parse(body)`; throws if the body is not JSON. */
  json(): any;
}

type FakeHandler = (req: RecordedRequest) => unknown | Response | Promise<unknown | Response>;

interface FakeResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Raw text body. */
  text?: string;
  /** Path to a file whose contents are the body (JSON content-type if it ends in .json). */
  file?: string;
}

const SPEC = Symbol("fakeFetch.spec");
type MarkedSpec = FakeResponseSpec & { [SPEC]: true };

/** Explicit response: status, headers, and a json/text/file body. */
export function respond(spec: FakeResponseSpec): MarkedSpec {
  return { ...spec, [SPEC]: true };
}

/** Respond with the contents of a fixture file. */
export function fixture(path: string, opts: Omit<FakeResponseSpec, "file" | "json" | "text"> = {}): MarkedSpec {
  return respond({ ...opts, file: path });
}

interface FakeRoute {
  method?: string; // default: any
  url: string | RegExp;
  /** Handler function, Response, respond()/fixture() spec, or any JSON value. */
  response: unknown;
  /** Remove the route after its first match (for "401 then 200" sequences). */
  once?: boolean;
}

/** Either a route list, or `{ "METHOD pattern": response }` (method optional: `"* pattern"` or just `"pattern"`). */
type FakeRoutes = FakeRoute[] | Record<string, unknown>;

const FAKE_IP = "127.0.0.2";

function toRouteList(routes: FakeRoutes): FakeRoute[] {
  if (Array.isArray(routes)) return [...routes];
  return Object.entries(routes).map(([key, response]) => {
    const m = key.match(/^([A-Z]+|\*)\s+(.+)$/);
    if (m) return { method: m[1] === "*" ? undefined : m[1], url: m[2]!, response };
    return { url: key, response };
  });
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`);
}

function urlMatches(pattern: string | RegExp, url: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(url);
  const u = new URL(url);
  const pathQuery = u.pathname + u.search;
  if (!pattern.includes("*")) return pattern === url || pattern === pathQuery || pattern === u.pathname;
  const re = globToRegExp(pattern);
  return re.test(url) || re.test(pathQuery) || re.test(u.pathname);
}

async function readBody(input: string | URL | Request, init?: RequestInit): Promise<string | null> {
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body as ArrayBuffer);
  if (body instanceof Blob) return await body.text();
  if (body instanceof FormData) {
    return JSON.stringify([...body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).name}>`]));
  }
  return String(body);
}

function toResponse(value: unknown): Response {
  if (value instanceof Response) return value.clone() as Response;
  if (value && typeof value === "object" && (value as any)[SPEC]) {
    const spec = value as MarkedSpec;
    const headers = new Headers(spec.headers ?? {});
    let body: string | null = null;
    if (spec.file !== undefined) {
      body = readFileSync(spec.file, "utf8");
      if (spec.file.endsWith(".json") && !headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (spec.text !== undefined) {
      body = spec.text;
    } else if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return new Response(body, { status: spec.status ?? 200, headers });
  }
  if (typeof value === "string") return new Response(value, { status: 200 });
  return new Response(JSON.stringify(value ?? null), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  /** Requests that matched no route (each also threw). */
  readonly unmatched: RecordedRequest[] = [];
  private routes: FakeRoute[];
  private original: typeof fetch | null = null;

  constructor(routes: FakeRoutes = []) {
    this.routes = toRouteList(routes);
  }

  /** Add routes; later routes are tried after earlier ones. */
  add(routes: FakeRoutes): this {
    this.routes.push(...toRouteList(routes));
    return this;
  }

  /** The fetch implementation (usable without installing). */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const wireUrl = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const headerObj: Record<string, string> = {};
    headers.forEach((v, k) => { headerObj[k] = v; });

    // Undo IPv4 pinning: https://1.2.3.4/x + Host: h → https://h/x
    const u = new URL(wireUrl);
    const host = headers.get("host");
    if (host && /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) u.hostname = host;
    const url = u.toString();

    const body = await readBody(input, init);
    const req: RecordedRequest = {
      method,
      url,
      wireUrl,
      headers: headerObj,
      body,
      json: () => JSON.parse(body ?? ""),
    };
    this.requests.push(req);

    const idx = this.routes.findIndex(r => (!r.method || r.method.toUpperCase() === method) && urlMatches(r.url, url));
    if (idx < 0) {
      this.unmatched.push(req);
      const known = this.routes.map(r => `${r.method ?? "*"} ${String(r.url)}`).join(", ") || "(none)";
      throw new Error(`fakeFetch: no route for ${method} ${url}. Registered: ${known}`);
    }
    const route = this.routes[idx]!;
    if (route.once) this.routes.splice(idx, 1);
    const value = typeof route.response === "function" ? await (route.response as FakeHandler)(req) : route.response;
    return toResponse(value);
  };

  /** Requests filtered by method and/or URL pattern (same matching rules as routes). */
  calls(method?: string, pattern?: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      r => (!method || r.method === method.toUpperCase()) && (!pattern || urlMatches(pattern, r.url))
    );
  }

  /** Replace globalThis.fetch and stub DNS. Idempotent. */
  install(): this {
    if (this.original) return this;
    this.original = globalThis.fetch;
    globalThis.fetch = Object.assign(this.fetch, { preconnect: () => {} }) as unknown as typeof fetch;
    setIpv4ResolverForTesting(() => FAKE_IP);
    return this;
  }

  /** Put the real fetch and DNS back. */
  restore(): void {
    if (!this.original) return;
    globalThis.fetch = this.original;
    this.original = null;
    setIpv4ResolverForTesting(null);
  }

  [Symbol.dispose](): void {
    this.restore();
  }
}

/** Create a FakeFetch (not yet installed — call `.install()`). */
export function fakeFetch(routes: FakeRoutes = []): FakeFetch {
  return new FakeFetch(routes);
}
