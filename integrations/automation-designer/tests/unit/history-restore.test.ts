// `ad history restore`: a platform answer of `false` is a failed restore and
// must produce an ok:false envelope (found while making the history sub-action
// return types honest: they claimed `ok: true` only). Also covers logIntent
// reporting the *active* env rather than BELZ_ENV (AD-27).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { withTempEnvConfig, runCommand } from "@belzabar/core/testing";
import historyCommand from "../../commands/history/index";
import { adApi } from "../../lib/api/index";
import { CacheManager } from "../../lib/cache";
import { logIntent } from "../../lib/args/confirm";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

function fakeAd(restoreResult: boolean) {
  spies.push(
    spyOn(adApi, "fetchMethod").mockResolvedValue({
      uuid: "abc",
      referenceId: "ref",
      name: "myMethod",
      version: 7,
      category: { name: "Cat" },
    } as any),
    spyOn(adApi, "historyRestore").mockResolvedValue(restoreResult),
    spyOn(CacheManager, "invalidate").mockResolvedValue(undefined as any),
    spyOn(process.stderr, "write").mockImplementation(() => true),
  );
}

describe("ad history restore", () => {
  test("restore returning false -> ok:false RESTORE_FAILED with data", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    fakeAd(false);
    const r = await runCommand(historyCommand, ["restore", "abc", "--version", "3", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("RESTORE_FAILED");
    expect((r.envelope?.data as any)?.success).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  test("restore returning true -> ok:true", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    fakeAd(true);
    const r = await runCommand(historyCommand, ["restore", "abc", "--version", "3", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any)?.success).toBe(true);
  });
});

describe("logIntent (AD-27)", () => {
  test("reports the active env, not BELZ_ENV", () => {
    using _cfg = withTempEnvConfig({
      envs: { "t-dev": { url: "https://t.test" }, "t-qa": { url: "https://q.test" } },
      activeEnv: "t-qa",
    });
    const prev = process.env.BELZ_ENV;
    process.env.BELZ_ENV = "t-dev";
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      logIntent("POST", "x");
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.BELZ_ENV;
      else process.env.BELZ_ENV = prev;
    }
    expect(writes.join("")).toContain('"env":"t-qa"');
  });
});
