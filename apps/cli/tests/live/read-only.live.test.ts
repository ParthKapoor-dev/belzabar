// Opt-in live smoke (read-only) against the env named by BELZ_LIVE:
//   BELZ_LIVE=<env> [BELZ_LIVE_METHOD=<published uuid>] [BELZ_LIVE_CATEGORY=… BELZ_LIVE_CATEGORY_ID=…] \
//     bun test apps/cli/tests/live
// Skipped otherwise. Uses a tmp copy of ~/.belz (see core/testing live.ts).
import { expect, test } from "bun:test";
import { EnvelopeSchema, LIVE_ENV, describeLive, liveMethod, spawnLive } from "@belzabar/core/testing";

describeLive("read-only smoke", () => {
  test("envs lists the live env as active", async () => {
    const r = await spawnLive(["envs", "--llm"], { timeoutMs: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    const data = r.envelope!.data as { active: string; envs: { name: string }[] };
    expect(data.active).toBe(LIVE_ENV);
    expect(data.envs.some(e => e.name === LIVE_ENV)).toBe(true);
  }, 40_000);

  test("ad categories returns categories", async () => {
    const r = await spawnLive(["ad", "categories", "--llm"], { timeoutMs: 60_000 });
    expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
    expect({ ok: r.envelope?.ok, error: r.envelope?.error ?? null }).toEqual({ ok: true, error: null });
    expect(r.envelope!.meta.env).toBe(LIVE_ENV);
    expect(JSON.stringify(r.envelope!.data).length).toBeGreaterThan(100);
  }, 70_000);

  test("spawnLive refuses other envs", async () => {
    await expect(spawnLive(["envs", "--env", `${LIVE_ENV}-other`])).rejects.toThrow(/refused/);
  });

  // Smoke-matrix regressions that need the real server.
  // A long-lived published method with a large history (BELZ_LIVE_METHOD); tests that need it skip without it.
  const MID = liveMethod();

  test.skipIf(!MID)("a >64 KB --llm envelope arrives whole through a pipe", async () => {
    const r = await spawnLive(["ad", "history", "show", MID!, "--version", "1", "--full", "--llm"], { timeoutMs: 90_000 });
    expect(r.stdout.length).toBeGreaterThan(65_536);
    expect(r.envelope?.ok).toBe(true);
  }, 100_000);

  test.skipIf(!MID)("--env=<name> is honoured", async () => {
    const r = await spawnLive(["ad", "show", MID!, `--env=${LIVE_ENV}`, "--llm"], { timeoutMs: 60_000 });
    expect(r.envelope?.meta.env).toBe(LIVE_ENV);
  }, 70_000);

  const CATEGORY = process.env.BELZ_LIVE_CATEGORY?.trim();
  const CATEGORY_ID = Number(process.env.BELZ_LIVE_CATEGORY_ID);
  test.skipIf(!CATEGORY || !CATEGORY_ID)("the configured live category has the configured chain-category id", async () => {
    const r = await spawnLive(["ad", "categories", "--llm"], { timeoutMs: 60_000 });
    const rows = (r.envelope?.data as { categories: Array<{ id: number; name: string }> }).categories;
    expect(rows.find((c) => c.name === CATEGORY)?.id).toBe(CATEGORY_ID);
  }, 70_000);

  test("unknown uuids fail METHOD_NOT_FOUND", async () => {
    const missing = "4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (const argv of [["ad", "show", missing], ["ad", "state", missing], ["ad", "test-cases", missing]]) {
      const r = await spawnLive([...argv, "--llm"], { timeoutMs: 60_000 });
      expect(r.envelope?.error?.code).toBe("METHOD_NOT_FOUND");
    }
  }, 190_000);

  test("sql run refuses writes client-side", async () => {
    const r = await spawnLive(["ad", "sql", "run", "delete from belz_tst_nothing where 1=0", "--db", "any_db", "--llm"], { timeoutMs: 30_000 });
    expect(r.envelope?.error?.code).toBe("SQL_NOT_READ_ONLY");
  }, 40_000);

  test("find: totalMatches counts beyond --limit", async () => {
    const r = await spawnLive(["ad", "find", "a", "--limit", "1", "--llm"], { timeoutMs: 300_000 });
    const d = r.envelope?.data as { totalMatches: number; matches: unknown[] };
    expect(d.matches.length).toBe(1);
    expect(d.totalMatches).toBeGreaterThan(1);
  }, 310_000);
});
