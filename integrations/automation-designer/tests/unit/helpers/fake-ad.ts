// Shared setup for AD command tests that run against a fake server: a temp env
// config, silenced stderr, fakeFetch routes, and the route builders several
// suites need (definitions, categories, history lookup, compiled cache, a V2
// method store).
//
//   const ad = fakeAdEnv();
//   afterEach(() => ad.restore());
//   test("…", async () => {
//     ad.install([definitionRoute(), ...compiledCacheRoutes()]);
//     await runCommand(cmd, argv, { env: ENV });
//     ad.ff.requests …
//   });
import { spyOn } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { fakeFetch, fixture, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import { COMPILED_CACHE_ROUTES } from "../../../lib/save/compiled-cache";
import type { V2MethodResponse } from "../../../lib/types/v2-wire";

export const ENV = "t-dev";
export const HOST = "https://t-dev.test";
export const FIX = join(import.meta.dir, "..", "..", "fixtures");

type Routes = Parameters<typeof fakeFetch>[0];
type Route = { method?: string; url: string | RegExp; response: unknown };

export interface FakeAdEnv {
  /** The installed fakeFetch (throws before `install`). */
  readonly ff: FakeFetch;
  /** Temp config with `env` active, and (unless `quiet: false`) stderr silenced. Idempotent. */
  env(): void;
  /** `env()`, then install `routes` behind fakeFetch (replacing an earlier install). */
  install(routes: Routes): FakeFetch;
  /** Undo everything; call from afterEach. */
  restore(): void;
}

export function fakeAdEnv(opts: { env?: string; quiet?: boolean } = {}): FakeAdEnv {
  const name = opts.env ?? ENV;
  let cfg: TempEnvConfig | null = null;
  let ff: FakeFetch | null = null;
  let quiet: { mockRestore(): void } | null = null;
  const self: FakeAdEnv = {
    get ff() {
      if (!ff) throw new Error("fakeAdEnv: install() has not run");
      return ff;
    },
    env() {
      cfg ??= withTempEnvConfig({ envs: { [name]: { url: HOST } }, activeEnv: name });
      if (opts.quiet !== false) quiet ??= spyOn(process.stderr, "write").mockImplementation(() => true);
    },
    install(routes) {
      self.env();
      ff?.restore();
      ff = fakeFetch(routes).install();
      return ff;
    },
    restore() {
      ff?.restore();
      cfg?.restore();
      quiet?.mockRestore();
      ff = cfg = quiet = null;
    },
  };
  return self;
}

/** A fresh copy of the real service definition fixture (`definitions/976.json`). */
export const definitionFixture = (): any => JSON.parse(readFileSync(join(FIX, "definitions", "976.json"), "utf8"));

/** GET /rest/api/automations/<id>: the definition fixture, optionally edited per request. */
export function definitionRoute(edit?: (def: any, id: number) => void): Route {
  return {
    method: "GET",
    url: /\/rest\/api\/automations\/(\d+)/,
    response: (req: RecordedRequest) => {
      const def = definitionFixture();
      edit?.(def, Number(/automations\/(\d+)/.exec(req.url)![1]));
      return def;
    },
  };
}

/** The user and system chain-category listings. */
export function categoryRoutes(): Route[] {
  return [
    { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=false", response: fixture(`${FIX}/categories/chain-category.json`) },
    { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=true", response: fixture(`${FIX}/categories/chain-category-system.json`) },
  ];
}

/** The Method.History service lookup; each history operation then runs as `/chain/execute/hist-<op>`. */
export function historyServiceRoute(): Route {
  return {
    method: "GET",
    url: /automation-systems\/Expertly\.Automation\.Method\.History\/automation-apis\//,
    response: (req: RecordedRequest) => ({ serviceChainUID: `hist-${req.url.split("/").pop()}` }),
  };
}

/** Both compiled-cache invalidation POSTs a save or publish sends. */
export function compiledCacheRoutes(response: unknown = () => "success"): Route[] {
  return COMPILED_CACHE_ROUTES.map((url) => ({ method: "POST", url, response }));
}

export interface V2Store {
  stored: V2MethodResponse;
  gets: number;
  posts: V2MethodResponse[];
  routes: Route[];
}

/**
 * One V2 method on the fake server. GET `/chain/v2/<uuid>` returns a copy of
 * `stored` (through `onGet(n, body)` if given); POST `/chain/v2` records the
 * body, passes it through `onPost` (a result without `metadata`, e.g. a
 * respond() error, is returned as is), bumps `metadata.version.name` and
 * stores it.
 */
export function v2Store(
  uuid: string,
  initial: V2MethodResponse,
  opts: {
    onGet?: (n: number, body: V2MethodResponse) => V2MethodResponse;
    onPost?: (body: V2MethodResponse) => V2MethodResponse | object;
  } = {},
): V2Store {
  const s: V2Store = { stored: initial, gets: 0, posts: [], routes: [] };
  s.routes = [
    {
      method: "GET",
      url: `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`,
      response: () => {
        s.gets++;
        const b = structuredClone(s.stored);
        return opts.onGet ? opts.onGet(s.gets, b) : b;
      },
    },
    {
      method: "POST",
      url: "/rest/api/automation/chain/v2",
      response: (req: RecordedRequest) => {
        const body = req.json() as V2MethodResponse;
        s.posts.push(body);
        const out = opts.onPost ? opts.onPost(structuredClone(body)) : structuredClone(body);
        if (!("metadata" in out)) return out;
        const next = out as V2MethodResponse;
        next.metadata.version = { ...next.metadata.version!, name: String(Number(s.stored.metadata.version?.name) + 1) };
        s.stored = next;
        return next;
      },
    },
  ];
  return s;
}
