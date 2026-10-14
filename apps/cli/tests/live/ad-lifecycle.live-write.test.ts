// Opt-in live WRITE suite: the full AD method lifecycle on the WI_IMPL_LIVE env, in
// the WI_IMPL_LIVE_CATEGORY category only, names `wi_impl_tst_life_*` / `wi_impl_tst_del_*`.
//
//   WI_IMPL_LIVE=<env> WI_IMPL_LIVE_WRITE=1 WI_IMPL_LIVE_CATEGORY=<name> WI_IMPL_LIVE_CATEGORY_ID=<id> \
//     bun test apps/cli/tests/live
//
// create --spec → validate / lint → structural save → test (+ --expect) →
// test-case create / export / sync → publish → test --compare-published →
// state → history → delete. Every created method is registered in
// live-resources.md as soon as it exists and soft-deleted in afterAll
// (published copies too, through tests/live/support/soft-delete.ts, since
// `ad delete` refuses them by design).
import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  EnvelopeSchema,
  LIVE_ENV,
  LIVE_WRITE_PREFIX,
  describeLiveWrite,
  liveCategory,
  liveBelzHome,
  markLiveResourceCleaned,
  registerLiveResource,
  scratchDir,
  spawnLive,
  type SpawnResult,
} from "@belzabar/core/testing";

const AGENT = "live-suite";
const STAMP = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
const NAME = `${LIVE_WRITE_PREFIX}life_${STAMP}`;
const NAME_DEL = `${LIVE_WRITE_PREFIX}del_${STAMP}`;
const T = 240_000;

// Resolved lazily: the suite is skipped (and needs no category) when WI_IMPL_LIVE_WRITE is off.
const category = () => liveCategory();

const created: string[] = [];
const cleaned = new Set<string>();

function track(uuid: string, what: string, name = NAME): void {
  created.push(uuid);
  registerLiveResource({
    agent: AGENT,
    kind: `method (${what}, ${LIVE_ENV}, ${category().name} ${category().id})`,
    identifier: uuid,
    purpose: `${name}: live lifecycle suite`,
    cleaned: "no — pending afterAll soft delete",
  });
}

function okData<T = Record<string, unknown>>(r: SpawnResult): T {
  expect(EnvelopeSchema.safeParse(r.envelope).success).toBe(true);
  expect({ ok: r.envelope?.ok, error: r.envelope?.error ?? null, exit: r.exitCode }).toEqual({ ok: true, error: null, exit: 0 });
  return r.envelope!.data as T;
}

function errCode(r: SpawnResult): string | undefined {
  expect(r.envelope?.ok).toBe(false);
  return (r.envelope?.error as { code?: string } | null)?.code;
}

async function cli(argv: string[], timeoutMs = T - 10_000): Promise<SpawnResult> {
  return spawnLive([...argv, "--llm"], { timeoutMs });
}

describeLiveWrite("ad lifecycle", () => {
  const dir = scratchDir("live-ad-");
  let draft = "";
  let published = "";
  let testCaseId = "";

  afterAll(async () => {
    const todo = [...created].reverse().filter(u => !cleaned.has(u));
    if (todo.length === 0) return;
    const proc = Bun.spawn(["bun", join(import.meta.dir, "support", "soft-delete.ts"), ...todo], {
      env: { ...process.env, WI_IMPL_HOME: liveBelzHome() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const results = JSON.parse(out.trim().split("\n").pop() || "[]") as { uuid: string; result: string }[];
    for (const r of results) {
      const done = r.result === "deleted" || r.result === "gone";
      markLiveResourceCleaned(r.uuid, done ? `yes — afterAll soft delete (${r.result}; V2 METHOD_NOT_FOUND)` : `NO — ${r.result}: clean up by hand`);
    }
    expect(results.every(r => r.result === "deleted" || r.result === "gone")).toBe(true);
  }, T);

  test("create --spec (compact) makes a draft in the live category", async () => {
    const spec = join(dir, "spec.json");
    writeFileSync(
      spec,
      JSON.stringify({
        name: NAME,
        category: category().name,
        summary: "wi-impl live lifecycle suite",
        inputs: ["name"],
        outputs: ["greetingOut"],
        steps: [
          { service: "Helpers.Legacy/echo", inputs: { Input: "Hello #{name}" }, outputs: [{ key: "response", as: "greetingOut" }] },
        ],
      })
    );
    const dry = okData<{ dryRun: boolean; valid: boolean }>(await cli(["ad", "create", "--spec", spec, "--dry-run"]));
    expect(dry).toMatchObject({ dryRun: true, valid: true });

    const r = await cli(["ad", "create", "--spec", spec, "--yes"]);
    const uuid = (r.envelope?.data as { uuid?: string } | undefined)?.uuid;
    if (uuid) track(uuid, "draft");
    const d = okData<{ uuid: string; name: string; state: string; category: { chainCategoryId: number }; stepCount: number }>(r);
    expect(d).toMatchObject({ name: NAME, state: "DRAFT", category: { chainCategoryId: category().id }, stepCount: 1 });
    draft = d.uuid;
  }, T);

  test("create refuses a duplicate name", async () => {
    expect(draft).not.toBe("");
    const r = await cli(["ad", "create", "--spec", join(dir, "spec.json"), "--yes"]);
    const uuid = (r.envelope?.data as { uuid?: string } | undefined)?.uuid;
    if (uuid) track(uuid, "unexpected duplicate draft");
    expect(errCode(r)).toBe("AD_METHOD_EXISTS");
  }, T);

  test("validate and lint pass on the new draft", async () => {
    const v = okData<{ errors: unknown[] }>(await cli(["ad", "validate", draft, "--online"]));
    expect(v.errors).toEqual([]);
    const l = await cli(["ad", "lint", draft]);
    expect(l.exitCode).toBe(0);
    expect(l.envelope?.ok).toBe(true);
  }, T);

  test("structural save: leaf edit + add-step + set-output, verified", async () => {
    const overlay = join(dir, "overlay.json");
    writeFileSync(
      overlay,
      JSON.stringify({
        summary: "wi-impl live lifecycle suite (saved)",
        ops: [
          { op: "set-output", key: "shoutOut" },
          {
            op: "add-step",
            after: 1,
            step: { service: "Helpers.Legacy/echo", inputs: { Input: "#{greetingOut}!" }, outputs: [{ key: "response", as: "shoutOut" }] },
          },
        ],
      })
    );
    const dry = okData<{ valid: boolean }>(await cli(["ad", "save", overlay, "--uuid", draft, "--dry-run"]));
    expect(dry.valid).toBe(true);
    const s = okData<{ draftUuid: string; applied: unknown[] }>(await cli(["ad", "save", overlay, "--uuid", draft, "--yes"]));
    expect(s.draftUuid).toBe(draft);
    expect(s.applied.length).toBeGreaterThan(0);
    const show = okData<{ steps: unknown[] }>(await cli(["ad", "show", draft]));
    expect(show.steps.length).toBe(2);
  }, T);

  test("test runs the draft; --expect passes and fails", async () => {
    const inputs = join(dir, "in.json");
    writeFileSync(inputs, JSON.stringify({ name: "World" }));
    const t = okData<{ outputs: Record<string, unknown>; expectations: { failed: number } }>(
      await cli(["ad", "test", draft, "--inputs", inputs, "--expect", "greetingOut=Hello World", "--expect", "shoutOut=Hello World!"])
    );
    expect(t.outputs).toMatchObject({ greetingOut: "Hello World", shoutOut: "Hello World!" });
    expect(t.expectations.failed).toBe(0);

    const bad = await cli(["ad", "test", draft, "--inputs", inputs, "--expect", "greetingOut=Hello Mars"]);
    expect(bad.exitCode).toBe(1);
    expect(errCode(bad)).toBe("AD_TEST_EXPECTATION_FAILED");
  }, T);

  test("test-case create → export → sync (in sync) → test --case", async () => {
    const caseName = `${NAME}.greet.ok.1`;
    const c = okData<{ testCase?: { id?: string }; id?: string }>(
      await cli(["ad", "test-case", "create", draft, "--name", caseName, "--input", "name=World", "--assert", "greetingOut=Hello World", "--yes"])
    );
    testCaseId = String(c.testCase?.id ?? c.id ?? "");

    const list = okData<{ total: number; testCases: { id: string; name: string }[] }>(await cli(["ad", "test-case", "list", draft]));
    const found = list.testCases.find(tc => tc.name === caseName);
    expect(found).toBeDefined();
    testCaseId = testCaseId || String(found!.id);

    const root = join(dir, "export");
    okData(await cli(["ad", "test-case", "export", draft, "--dir", root]));
    const methodDir = join(root, category().name, NAME);
    const caseFiles = readdirSync(join(methodDir, "cases"));
    expect(caseFiles.length).toBe(1);
    const caseFile = JSON.parse(readFileSync(join(methodDir, "cases", caseFiles[0]!), "utf8"));
    expect(caseFile).toMatchObject({ name: caseName, inputs: { name: "World" } });

    const plan = okData<{ create?: unknown[]; update?: unknown[] }>(await cli(["ad", "test-case", "sync", methodDir]));
    expect(plan.create ?? []).toEqual([]);
    expect(plan.update ?? []).toEqual([]);

    const run = okData<{ expectations: { total: number; failed: number } }>(
      await cli(["ad", "test", draft, "--case", join(methodDir, "cases", caseFiles[0]!)])
    );
    expect(run.expectations).toMatchObject({ total: 1, failed: 0 });
  }, T);

  test("publish promotes the draft and records the note", async () => {
    const r = await cli(["ad", "publish", draft, "--note", `wi-impl live suite ${STAMP}`, "--yes"]);
    const d = r.envelope?.data as { publishedUuid?: string; noteRecorded?: boolean } | undefined;
    if (d?.publishedUuid) track(d.publishedUuid, "PUBLISHED");
    okData(r);
    expect(d?.publishedUuid).toMatch(/^[0-9a-f]{32}$/);
    expect(d?.noteRecorded).toBe(true);
    published = d!.publishedUuid!;
  }, T);

  test("test --compare-published: identical outputs", async () => {
    const d = okData<{ compare: { identical: boolean } }>(
      await cli(["ad", "test", draft, "--inputs", join(dir, "in.json"), "--compare-published", "--yes"])
    );
    expect(d.compare.identical).toBe(true);
  }, T);

  test("state: draft ↔ published linked and in sync", async () => {
    const d = okData<{ draftUuid: string; publishedUuid: string; inSync: boolean }>(await cli(["ad", "state", draft]));
    expect(d).toMatchObject({ draftUuid: draft, publishedUuid: published, inSync: true });
  }, T);

  test("draft edit → run draft vs published → history restore back in sync", async () => {
    const hist = okData<{ versions: { version: number }[] }>(await cli(["ad", "history", "list", draft]));
    const before = Math.max(...hist.versions.map(v => Number(v.version)));

    const overlay = join(dir, "overlay-howdy.json");
    writeFileSync(overlay, JSON.stringify({ ops: [{ op: "update-step", step: 1, set: { inputs: { Input: "Howdy #{name}" } } }] }));
    okData(await cli(["ad", "save", overlay, "--uuid", draft, "--yes"]));
    expect(okData<{ inSync: boolean }>(await cli(["ad", "state", draft])).inSync).toBe(false);

    // The execute endpoint runs the uuid's own saved body: a draft uuid runs the draft.
    const payload = JSON.stringify({ name: "World" });
    const rd = okData<{ response: { greetingOut?: string }; publishedUuid: string }>(await cli(["ad", "run", draft, payload]));
    expect(rd.response.greetingOut).toBe("Howdy World");
    expect(rd.publishedUuid).toBe(published);
    const rp = okData<{ response: { greetingOut?: string } }>(await cli(["ad", "run", published, payload]));
    expect(rp.response.greetingOut).toBe("Hello World");

    const restored = okData<{ success: boolean }>(await cli(["ad", "history", "restore", draft, "--version", String(before), "--yes"]));
    expect(restored.success).toBe(true);
    expect(okData<{ inSync: boolean }>(await cli(["ad", "state", draft])).inSync).toBe(true);
  }, T);

  test("history list/show on the draft", async () => {
    const l = okData<{ versions?: { version: number }[] } & Record<string, unknown>>(await cli(["ad", "history", "list", draft]));
    const versions = (l.versions ?? []) as { version: number }[];
    expect(versions.length).toBeGreaterThan(0);
    const v = Math.max(...versions.map(x => Number(x.version)));
    const s = okData<{ steps?: unknown[] }>(await cli(["ad", "history", "show", draft, "--version", String(v)]));
    expect(Array.isArray(s.steps)).toBe(true);
  }, T);

  test("changelog lists the publish note", async () => {
    const d = okData<{ entries?: { note: string }[] } | { note: string }[]>(await cli(["ad", "changelog", draft]));
    expect(JSON.stringify(d)).toContain(`wi-impl live suite ${STAMP}`);
  }, T);

  test("delete refuses a published method and a draft with a published copy", async () => {
    expect(errCode(await cli(["ad", "delete", published, "--yes"]))).toBe("AD_DELETE_PUBLISHED");
    expect(errCode(await cli(["ad", "delete", draft, "--yes"]))).toBe("AD_DELETE_HAS_PUBLISHED");
  }, T);

  test("test-case delete removes the case", async () => {
    expect(testCaseId).not.toBe("");
    okData(await cli(["ad", "test-case", "delete", testCaseId, "--yes"]));
    const list = okData<{ testCases: { id: string }[] }>(await cli(["ad", "test-case", "list", draft]));
    expect(list.testCases.some(tc => String(tc.id) === testCaseId)).toBe(false);
  }, T);

  test("create (V2 subset spec) + delete a never-published draft, verified", async () => {
    const spec = join(dir, "spec-del.json");
    writeFileSync(spec, JSON.stringify({ name: NAME_DEL, summary: "wi-impl live delete probe", inputs: [], outputs: [], variables: [], steps: [] }));
    const r = await cli(["ad", "create", "--spec", spec, "--category", String(category().id), "--yes"]);
    const uuid = (r.envelope?.data as { uuid?: string } | undefined)?.uuid;
    if (uuid) track(uuid, "draft", NAME_DEL);
    const d = okData<{ uuid: string; state: string }>(r);
    expect(d.state).toBe("DRAFT");
    const del = okData<{ deleted: boolean; verified: boolean }>(await cli(["ad", "delete", d.uuid, "--yes"]));
    expect(del).toMatchObject({ deleted: true, verified: true });
    cleaned.add(d.uuid);
    markLiveResourceCleaned(d.uuid, "yes — wi-impl ad delete (verified V2 METHOD_NOT_FOUND)");
    const gone = await cli(["ad", "show", d.uuid, "--v2"]);
    expect(errCode(gone)).toBe("METHOD_NOT_FOUND");
  }, T);
});
