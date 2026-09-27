// `ad diff` (history mode) writes both sides to a fresh temp dir and leaves
// them for the editor. Under test, TMPDIR points at the run's BELZ_TEST_TMP
// scratch root (removed by the preload's afterAll) so nothing is left in /tmp.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { runCommand, scratchDir, withTempEnvConfig } from "@belzabar/core/testing";
import diffCommand from "../../commands/diff/index";
import { adApi } from "../../lib/api/index";

let prevTmp: string | undefined;
let root: string;
beforeAll(() => {
  prevTmp = process.env.TMPDIR;
  root = scratchDir("belz-ad-diff-test-");
  process.env.TMPDIR = root;
});
afterAll(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
});

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

const versionBody = (v: number) => ({
  methodID: "abc",
  methodVersion: v,
  methodVersionID: `vid-${v}`,
  isPublished: true,
  isDeactivated: false,
  addedBy: 1,
  addedWhen: "2026-01-01",
  jsonDefinition: { name: "m", inputs: [], services: [] },
});

describe("ad diff history mode", () => {
  test("writes both sides under the test tmp root (--no-editor)", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    spies.push(
      spyOn(adApi, "fetchMethod").mockResolvedValue({ name: "m", category: { name: "C" } } as any),
      spyOn(adApi, "historyGet").mockImplementation(async (o: { version: number }) => versionBody(o.version) as any),
    );
    const r = await runCommand(diffCommand, ["abcdef12", "--from", "1", "--to", "2", "--no-editor"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const data = r.envelope?.data as { left: { path: string }; right: { path: string }; editor: string | null };
    expect(data.editor).toBeNull();
    for (const p of [data.left.path, data.right.path]) {
      expect(p.startsWith(root)).toBe(true);
      expect(existsSync(p)).toBe(true);
      expect(() => JSON.parse(readFileSync(p, "utf8"))).not.toThrow();
    }
  });
});
