// F33: `belz cache` must send {"uuids":[…]} to BOTH invalidate routes and refuse an
// org-wide flush unless --all --yes is passed. No network: the fetcher is mocked.
import { describe, expect, test } from "bun:test";
import type { CliError } from "@belzabar/core";
import command, {
  buildInvalidateBody,
  CACHE_INVALIDATE_PATHS,
  invalidateOnAllRoutes,
} from "../commands/cache/index";

const ctx = { outputMode: "llm", env: { name: "test-env" }, warn: () => {} } as any;

function mockFetcher(responder: (path: string) => Response | Error) {
  const calls: { path: string; body: any; method?: string }[] = [];
  const fetcher = async (path: string, opts: any) => {
    calls.push({ path, body: JSON.parse(opts.body), method: opts.method });
    const r = responder(path);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetcher };
}

describe("cache request body", () => {
  test("uses the plural `uuids` key", () => {
    expect(buildInvalidateBody(["a", "b"], "AUTOMATION")).toEqual({ uuids: ["a", "b"], type: "AUTOMATION" });
  });

  test("POSTs the same body to both routes", async () => {
    const { calls, fetcher } = mockFetcher(() => new Response('"success"', { status: 200 }));
    const routes = await invalidateOnAllRoutes(buildInvalidateBody(["u1"], "AUTOMATION"), fetcher);
    expect(calls.map(c => c.path)).toEqual([...CACHE_INVALIDATE_PATHS]);
    expect(calls.map(c => c.path)).toEqual(["/rest/api/cache/invalidate", "/rest/api/automations/cache/invalidate"]);
    for (const c of calls) {
      expect(c.method).toBe("POST");
      expect(c.body).toEqual({ uuids: ["u1"], type: "AUTOMATION" });
      expect(c.body.uuid).toBeUndefined();
    }
    expect(routes.every(r => r.ok)).toBe(true);
  });

  test("tolerates one route failing and reports per-route results", async () => {
    const { fetcher } = mockFetcher(p =>
      p.includes("/automations/") ? new Response("No endpoint", { status: 500 }) : new Response('"success"', { status: 200 }),
    );
    const routes = await invalidateOnAllRoutes(buildInvalidateBody(["u1"], "AUTOMATION"), fetcher);
    expect(routes[0]).toMatchObject({ ok: true, status: 200 });
    expect(routes[1]).toMatchObject({ ok: false, status: 500 });
  });

  test("a thrown network error on one route is captured, not raised", async () => {
    const { fetcher } = mockFetcher(p => (p.includes("/automations/") ? new Error("ECONNRESET") : new Response("", { status: 200 })));
    const routes = await invalidateOnAllRoutes(buildInvalidateBody(["u1"], "AUTOMATION"), fetcher);
    expect(routes[1]).toMatchObject({ ok: false, status: null, error: "ECONNRESET" });
  });
});

describe("cache arg guard", () => {
  const parse = (a: string[]) => command.parseArgs!(a, ctx) as any;

  test("no uuids and no --all is refused", () => {
    expect(() => parse([])).toThrow(/--all --yes/);
  });

  test("--all without --yes is refused", () => {
    expect(() => parse(["--all"])).toThrow(/--yes/);
    expect(() => parse(["--yes"])).toThrow();
  });

  test("--all --yes is accepted", () => {
    expect(parse(["--all", "--yes"])).toMatchObject({ uuids: [], all: true, yes: true });
  });

  test("--all with uuids is refused", () => {
    expect(() => parse(["--all", "--yes", "u1"])).toThrow(/cannot be combined/);
  });

  test("CORE-R12: a mistyped subcommand or non-uuid is INVALID_UUID, never POSTed", async () => {
    const codeOf = (a: string[]) => {
      try {
        parse(a);
      } catch (e) {
        return (e as CliError).code;
      }
      return "none";
    };
    expect(codeOf(["prune"])).toBe("INVALID_UUID");
    expect(() => parse(["prune"])).toThrow(/prune-local/);
    expect(codeOf(["44014c3707d6b6d8ae848839a1c8d1e7", "not-a-uuid"])).toBe("INVALID_UUID");
    expect(parse(["44014c3707d6b6d8ae848839a1c8d1e7", "0d4a2b8c-1e2f-4a5b-8c9d-0e1f2a3b4c5d"]).uuids).toHaveLength(2);
    await expect(
      command.execute({ subcommand: "invalidate", uuids: ["prune"], type: "AUTOMATION", yes: false, all: false } as any, ctx),
    ).rejects.toThrow(/Invalid cache UUID/);
  });

  test("execute refuses an empty uuid list even if parseArgs is bypassed", async () => {
    await expect(command.execute({ uuids: [], type: "AUTOMATION", yes: true, all: false } as any, ctx)).rejects.toThrow();
  });
});
