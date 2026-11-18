// platform/server-cache.ts — repeated server-side cache clears (one request
// reaches one server of a load-balanced env). No network: the fetcher is mocked.
import { describe, expect, test } from "bun:test";
import { CACHE_INVALIDATE_PATHS, clearServerCache } from "../src/platform";

function fetcher(responder: (path: string, n: number) => Response | Error) {
  const calls: Array<{ path: string; body: any }> = [];
  const fn = async (path: string, opts: any) => {
    calls.push({ path, body: JSON.parse(opts.body) });
    const r = responder(path, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fn };
}

describe("clearServerCache", () => {
  test("repeat N sends N rounds to both routes and is verified when each reached one", async () => {
    const f = fetcher((p) => new Response("", { status: p.includes("/automations/") ? 404 : 200 }));
    const rounds: number[] = [];
    const out = await clearServerCache([" u1 ", "u1", "u2"], { repeat: 3, delayMs: 0, fetcher: f.fn, onRound: (r) => rounds.push(r.round) });
    expect(f.calls).toHaveLength(6);
    expect(f.calls.slice(0, 2).map((c) => c.path)).toEqual([...CACHE_INVALIDATE_PATHS]);
    expect(f.calls[0]!.body).toEqual({ uuids: ["u1", "u2"], type: "AUTOMATION" });
    expect(rounds).toEqual([1, 2, 3]);
    expect(out).toMatchObject({ uuids: ["u1", "u2"], okRounds: 3, verified: true });
    expect(out.rounds[0]!.routes[1]).toMatchObject({ ok: false, status: 404 });
  });

  test("a round where every route failed makes it unverified, not an exception", async () => {
    const f = fetcher((_p, n) => (n <= 2 ? new Error("ECONNRESET") : new Response("", { status: 200 })));
    const out = await clearServerCache(["u1"], { repeat: 2, delayMs: 0, fetcher: f.fn, type: "PAGE" });
    expect(out).toMatchObject({ type: "PAGE", okRounds: 1, verified: false });
    expect(out.rounds[0]).toMatchObject({ round: 1, ok: false });
  });

  test("an empty list is refused unless all is set (it would flush the organisation)", async () => {
    const f = fetcher(() => new Response("", { status: 200 }));
    expect(await clearServerCache(["", " "], { fetcher: f.fn })).toMatchObject({ rounds: [], verified: false });
    expect(f.calls).toHaveLength(0);
    expect((await clearServerCache([], { all: true, fetcher: f.fn })).verified).toBe(true);
    expect(f.calls[0]!.body).toEqual({ uuids: [], type: "AUTOMATION" });
  });
});
