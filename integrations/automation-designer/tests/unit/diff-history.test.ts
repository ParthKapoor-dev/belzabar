// `ad diff` (history mode) writes both sides to a fresh temp dir and leaves
// them for the editor. Under test, TMPDIR points at the run's WI_IMPL_TEST_TMP
// scratch root (removed by the preload's afterAll) so nothing is left in /tmp.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { fakeFetch, runCommand, scratchDir, withTempEnvConfig } from "@belzabar/core/testing";
import diffCommand, { fetchOnEnv, spawnEditor } from "../../commands/diff/index";
import { adApi } from "../../lib/api/index";

let prevTmp: string | undefined;
let root: string;
beforeAll(() => {
  prevTmp = process.env.TMPDIR;
  root = scratchDir("wi-impl-ad-diff-test-");
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

const UUID = "abcdef12abcdef12abcdef12abcdef12";
const versionBody = (v: number) => ({
  methodID: UUID,
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
      spyOn(adApi, "fetchMethod").mockResolvedValue({ uuid: UUID, state: "DRAFT", name: "m", category: { name: "C" } } as any),
      spyOn(adApi, "historyGet").mockImplementation(async (o: { version: number }) => versionBody(o.version) as any),
    );
    const r = await runCommand(diffCommand, [UUID, "--from", "1", "--to", "2", "--no-editor"], { env: "t-dev" });
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

// --llm never opens an editor by default; a missing binary is a warning.
describe("ad diff editor", () => {
  function stubHistory() {
    spies.push(
      spyOn(adApi, "fetchMethod").mockResolvedValue({ uuid: UUID, state: "DRAFT", name: "m", category: { name: "C" } } as any),
      spyOn(adApi, "historyGet").mockImplementation(async (o: { version: number }) => versionBody(o.version) as any),
    );
  }

  test("--llm without --editor launches nothing", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stubHistory();
    const r = await runCommand(diffCommand, [UUID, "--from", "1", "--to", "2"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as { editor: string | null }).editor).toBeNull();
  });

  test("an editor binary that cannot start → editor:null plus a warning, no crash", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    stubHistory();
    const r = await runCommand(diffCommand, [UUID, "--from", "1", "--to", "2", "--editor", "wi-impl-no-such-editor-zzz"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as { editor: string | null }).editor).toBeNull();
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toMatch(/Could not start editor 'wi-impl-no-such-editor-zzz'/);
  });

  test("spawnEditor resolves null when the process starts", async () => {
    expect(await spawnEditor("true", "a", "b")).toBeNull();
    expect(await spawnEditor("wi-impl-no-such-editor-zzz", "a", "b")).toEqual(expect.any(String));
  });
});

// cross-env diff is in-process (no `wi-impl` subprocess) and compares the
// semantic view, so a code-only change is visible and env-local ids are not.
describe("ad diff cross-env", () => {
  const method = (env: string, code: string, automationId: number) =>
    ({
      uuid: UUID,
      state: "PUBLISHED",
      name: "m",
      summary: "",
      category: { name: "C" },
      inputs: [],
      variables: [],
      outputs: [],
      parsedSteps: [
        { orderIndex: 1, kind: "CUSTOM_CODE", description: "cc", language: "JAVASCRIPT", source: code, inputs: [], outputs: [], automationId, raw: { env } },
      ],
    }) as any;

  async function run(codes: Record<string, string>) {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" }, "t-qa": { url: "https://q.test" } } });
    const { Config } = await import("@belzabar/core");
    const seen: string[] = [];
    spies.push(
      spyOn(adApi, "fetchMethod").mockImplementation(async () => {
        const env = Config.activeEnv.name;
        seen.push(env);
        return method(env, codes[env]!, env === "t-dev" ? 1 : 2);
      }),
    );
    const r = await runCommand(diffCommand, [UUID, "--from-env", "t-dev", "--to-env", "t-qa", "--no-editor"], { env: "t-dev" });
    // fetchOnEnv restores the active env
    Config.setActiveEnv("t-dev");
    await fetchOnEnv(UUID, "t-qa");
    const activeAfter = Config.activeEnv.name;
    return { r, seen: seen.slice(0, 2), activeAfter };
  }

  test("a code-only change is reported; the active env is restored", async () => {
    const { r, seen, activeAfter } = await run({ "t-dev": "return 1;", "t-qa": "return 2;" });
    expect(activeAfter).toBe("t-dev");
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(seen).toEqual(["t-dev", "t-qa"]);
    expect(d.changed).toBe(true);
    expect(d.differences).toEqual(["$.steps[0].body.src"]);
    expect(JSON.parse(readFileSync(d.left.path, "utf8")).steps[0].body.src).toBe("return 1;");
  });

  test("identical logic with different env-local ids -> changed:false", async () => {
    const { r } = await run({ "t-dev": "return 1;", "t-qa": "return 1;" });
    expect((r.envelope?.data as any).changed).toBe(false);
  });

  test("unknown env -> INVALID_ENV", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    const r = await runCommand(diffCommand, [UUID, "--from-env", "t-dev", "--to-env", "nope", "--no-editor"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("INVALID_ENV");
  });
});

// K15: a migrated V1 jsonDefinition kept two input mappings whose callee input
// does not resolve on the target env (they name the source env's callee-input
// uuids). V2 (and the runtime) drop them, the V1 parse did not, so the step
// that passes one input on stage compared equal to qa's three. Real captures.
describe("ad diff cross-env reads V2 (K15)", () => {
  const FIX = join(import.meta.dir, "../fixtures/cross-env");
  const DRAFT = "4d6d5ff1b4961a90bfc79e6a0fb92c53";
  const body = (env: string, v: string) => JSON.parse(readFileSync(join(FIX, `${DRAFT}.acme-${env}.draft.${v}.json`), "utf8"));

  async function run() {
    using _cfg = withTempEnvConfig({ envs: { "t-qa": { url: "https://q.test" }, "t-stage": { url: "https://s.test" } } });
    using _ff = fakeFetch({
      [`GET https://q.test/rest/api/automation/chain/v2/${DRAFT}?basicInfo=false`]: body("qa", "v2"),
      [`GET https://s.test/rest/api/automation/chain/v2/${DRAFT}?basicInfo=false`]: body("stage", "v2"),
      [`GET https://q.test/rest/api/automation/chain/${DRAFT}`]: body("qa", "v1"),
      [`GET https://s.test/rest/api/automation/chain/${DRAFT}`]: body("stage", "v1"),
    }).install();
    return await runCommand(diffCommand, [DRAFT, "--from-env", "t-qa", "--to-env", "t-stage", "--no-editor"], { env: "t-qa" });
  }

  test("the stored V1 bodies still list all three mappings on both envs", () => {
    const step2 = (env: string) =>
      (JSON.parse(body(env, "v1").jsonDefinition).services as any[]).find((s) => s.orderIndex === 2);
    expect(step2("qa").mappings.length).toBe(3);
    expect(step2("stage").mappings.length).toBe(3);
    // the two dangling ones carry no numeric input id on stage
    expect(step2("stage").mappings.filter((m: any) => m.automationUserInputId == null).length).toBe(2);
    expect(body("stage", "v2").steps[1].inputs.length).toBe(1);
  });

  test("the dropped child-step inputs are a difference", async () => {
    const r = await run();
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.changed).toBe(true);
    expect(d.differences).toContain("$.steps[1].inputs[1]");
    expect(d.differences).toContain("$.steps[1].inputs[2]");
    expect(JSON.parse(readFileSync(d.right.path, "utf8")).steps[1].inputs.length).toBe(1);
  });
});
