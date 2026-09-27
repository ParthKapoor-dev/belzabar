// Opt-in live smoke (read-only) against sems-dev:
//   BELZ_LIVE=sems-dev bun test apps/cli/tests/live
// Skipped otherwise. Uses a tmp copy of ~/.belz (see core/testing live.ts).
import { expect, test } from "bun:test";
import { EnvelopeSchema, LIVE_ENV, describeLive, spawnLive } from "@belzabar/core/testing";

describeLive("read-only smoke", () => {
  test("envs lists sems-dev as active", async () => {
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
    await expect(spawnLive(["envs", "--env", "nsm-dev"])).rejects.toThrow(/refused/);
  });
});
