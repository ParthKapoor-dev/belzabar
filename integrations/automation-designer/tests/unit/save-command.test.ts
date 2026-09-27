// `ad save` — V2 pipeline end to end against a fake sems-dev (fakeFetch):
// draft guard → overlay → validate → confirm → freshness re-GET (AD-08) →
// POST /chain/v2 → post-save verify (AD-01) → compiled cache on both routes
// (AD-20) → local cache.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  fakeFetch,
  respond,
  runCommand,
  scratchDir,
  withTempEnvConfig,
  type FakeFetch,
  type RecordedRequest,
  type TempEnvConfig,
} from "@belzabar/core/testing";
import saveCommand from "../../commands/save/index";
import { __setValidatorsForTests } from "../../lib/save/validation";
import { CacheManager } from "../../lib/cache";
import { COMPILED_CACHE_ROUTES } from "../../lib/save/compiled-cache";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

const DIR = `${import.meta.dir}/../fixtures/real-v2`;
const U = "41bb1b438875bd8b994196db1f12b7c2"; // DRAFT; 1: SQL read, 2: CC plain
const PUB = "0000000000000000000000000000beef";
const GET = `/rest/api/automation/chain/v2/${U}?basicInfo=false`;
const base = (): V2MethodResponse => structuredClone(require(`${DIR}/${U}.v2.json`));
const V0 = String(base().metadata.version!.name);

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  __setValidatorsForTests();
  while (spies.length) spies.pop()!.mockRestore();
});

interface Server {
  stored: V2MethodResponse;
  gets: number;
  posts: V2MethodResponse[];
}

interface Opts {
  /** Mutate what the Nth GET returns (1 = guard, 2 = freshness, 3 = verify). */
  onGet?: (n: number, body: V2MethodResponse) => V2MethodResponse;
  /** Server-side transformation of a POSTed body before storing. */
  onPost?: (body: V2MethodResponse) => V2MethodResponse | object;
  published?: boolean;
  invalidate?: (req: RecordedRequest) => unknown;
}

function wire(opts: Opts = {}): Server {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
  const s: Server = { stored: base(), gets: 0, posts: [] };
  if (opts.published) s.stored.metadata.referenceId = `${PUB}    `;
  ff = fakeFetch([
    {
      method: "GET",
      url: GET,
      response: () => {
        s.gets++;
        const b = structuredClone(s.stored);
        return opts.onGet ? opts.onGet(s.gets, b) : b;
      },
    },
    {
      method: "GET",
      url: `/rest/api/automation/chain/v2/${PUB}?basicInfo=false`,
      response: () => ({ ...base(), uuid: PUB, metadata: { ...base().metadata, state: "PUBLISHED", referenceId: `${U}    ` } }),
    },
    {
      method: "POST",
      url: "/rest/api/automation/chain/v2",
      response: (req: RecordedRequest) => {
        const body = req.json() as V2MethodResponse;
        s.posts.push(body);
        const out = opts.onPost ? opts.onPost(structuredClone(body)) : structuredClone(body);
        if (!("metadata" in out)) return out; // an explicit respond() error
        const next = out as V2MethodResponse;
        next.metadata.version = { ...next.metadata.version!, name: String(Number(s.stored.metadata.version?.name) + 1) };
        next.metadata.internal = { ...next.metadata.internal, migrationVersion: 1 };
        s.stored = next;
        return next;
      },
    },
    ...COMPILED_CACHE_ROUTES.map((p) => ({ method: "POST", url: p, response: opts.invalidate ?? (() => "success") })),
  ]).install();
  return s;
}

function overlayFile(o: unknown): string {
  const p = join(scratchDir("ad-save"), `o-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(o));
  return p;
}

const run = (overlay: unknown, ...extra: string[]) =>
  runCommand(saveCommand, [overlayFile(overlay), "--uuid", U, "--yes", ...extra], { env: "t-dev" });
const paths = (f: FakeFetch) => f.requests.map((r) => `${r.method} ${r.url.replace("https://t-dev.test", "")}`);

describe("ad save (V2 pipeline)", () => {
  test("happy path: GET, fresh GET, POST /chain/v2, verify GET, both cache routes; data shape", async () => {
    const s = wire();
    await CacheManager.save(U, { uuid: U } as any, "t-dev");
    const r = await run({ summary: "new summary", parsedSteps: [{ orderIndex: 2, source: "console.log(1)" }] });
    expect(r.envelope?.ok).toBe(true);
    expect(paths(ff!)).toEqual([
      `GET ${GET}`,
      `GET ${GET}`,
      "POST /rest/api/automation/chain/v2",
      `GET ${GET}`,
      "POST /rest/api/cache/invalidate",
      "POST /rest/api/automations/cache/invalidate",
    ]);
    const d = r.envelope!.data as any;
    expect(d).toMatchObject({
      action: "UPDATED",
      draftUuid: U,
      publishedUuid: null,
      switchedFromPublished: false,
      previousVersion: V0,
      version: String(Number(V0) + 1),
      applied: ["summary", "parsedSteps[orderIndex=2].source"],
      unchanged: [],
      validation: { skipped: false, layersRun: ["L1", "L2", "L3"] },
    });
    // The real validator runs; this fixture's findings are all pre-existing (diff-aware).
    expect(d.validation.warnings.every((w: any) => w.preexisting)).toBe(true);
    expect(d.compiledCache.ok).toBe(true);
    // Payload: live body + exactly the two leaves; metadata untouched, plain code plain.
    const sent = s.posts[0]!;
    expect(sent.metadata).toEqual(base().metadata);
    expect(sent.steps![1]!.properties!.customCode!.inlineCode).toBe("console.log(1)");
    expect(sent.steps![0]).toEqual(base().steps![0]);
    // invalidate body: one uuid, AUTOMATION, never empty
    const inv = ff!.requests.filter((q) => q.url.endsWith("cache/invalidate")).map((q) => q.json());
    expect(inv).toEqual([
      { uuids: [U], type: "AUTOMATION" },
      { uuids: [U], type: "AUTOMATION" },
    ]);
    expect(await CacheManager.load(U, "t-dev")).toBeNull();
  });

  test("lean chain (steps without automationAPIId) saves via V2", async () => {
    wire();
    const r = await run({ parsedSteps: [{ orderIndex: 1, sql: "select 1" }] });
    expect(r.envelope?.ok).toBe(true);
  });

  test("PUBLISHED uuid → saves its linked draft", async () => {
    const s = wire({ published: true });
    const r = await runCommand(saveCommand, [overlayFile({ description: "x" }), "--uuid", PUB, "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope!.data as any).switchedFromPublished).toBe(true);
    expect((r.envelope!.data as any).draftUuid).toBe(U);
    expect(s.posts[0]!.uuid).toBe(U);
  });

  test("AD-08: draft moved between read and POST → AD_VERSION_CONFLICT, nothing POSTed", async () => {
    const s = wire({
      onGet: (n, b) => {
        if (n >= 2) b.metadata.version!.name = "99";
        return b;
      },
    });
    const r = await run({ summary: "x" });
    expect(r.envelope?.error?.code).toBe("AD_VERSION_CONFLICT");
    expect((r.envelope?.error?.details as any).currentVersion).toBe("99");
    expect(s.posts).toHaveLength(0);
  });

  test("AD-08: same version but a changed body is a conflict too", async () => {
    const s = wire({
      onGet: (n, b) => {
        if (n >= 2) b.description = "someone else";
        return b;
      },
    });
    const r = await run({ summary: "x" });
    expect(r.envelope?.error?.code).toBe("AD_VERSION_CONFLICT");
    expect(s.posts).toHaveLength(0);
  });

  test("AD-01: server drops a field → AD_SAVE_VERIFY_FAILED with a diff; caches still evicted", async () => {
    wire({
      onPost: (b) => {
        b.summary = base().summary as string; // not persisted
        return b;
      },
    });
    const r = await run({ summary: "lost", description: "kept" });
    expect(r.envelope?.error?.code).toBe("AD_SAVE_VERIFY_FAILED");
    const d = r.envelope?.error?.details as any;
    expect(d.notLanded.map((n: any) => n.key)).toEqual(["summary"]);
    expect(d.notLanded[0].expected).toBe("lost");
    expect(paths(ff!).filter((p) => p.endsWith("cache/invalidate"))).toHaveLength(2);
  });

  test("verify: an unrequested change on the server → AD_SAVE_VERIFY_FAILED (unexpected paths)", async () => {
    wire({
      onPost: (b) => {
        b.steps![0]!.description = "server rewrote me";
        return b;
      },
    });
    const r = await run({ summary: "x" });
    expect(r.envelope?.error?.code).toBe("AD_SAVE_VERIFY_FAILED");
    expect((r.envelope?.error?.details as any).unexpected).toEqual(["steps[0].description"]);
  });

  test("server 400 on POST → AD_SAVE_REJECTED with its message; caches evicted", async () => {
    wire({ onPost: () => respond({ status: 400, json: { errorMessage: "Invalid state, provided state does not match." } }) });
    const r = await run({ summary: "x" });
    expect(r.envelope?.error?.code).toBe("AD_SAVE_REJECTED");
    expect(r.envelope?.error?.message).toContain("Invalid state");
    expect(paths(ff!).filter((p) => p.endsWith("cache/invalidate"))).toHaveLength(2);
  });

  test("one cache route failing is tolerated (ok when any route answers 2xx)", async () => {
    wire({ invalidate: (req) => (req.url.includes("/automations/") ? respond({ status: 500, text: "x" }) : "success") });
    const r = await run({ summary: "x" });
    expect(r.envelope?.ok).toBe(true);
    const cc = (r.envelope!.data as any).compiledCache;
    expect(cc.ok).toBe(true);
    expect(cc.routes.map((x: any) => x.status)).toEqual([200, 500]);
  });

  test("--llm without --yes → AD_CONFIRMATION_REQUIRED before the freshness GET / POST", async () => {
    const s = wire();
    const r = await runCommand(saveCommand, [overlayFile({ summary: "x" }), "--uuid", U], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(s.gets).toBe(1);
    expect(s.posts).toHaveLength(0);
  });

  test("refused overlay → nothing POSTed", async () => {
    const s = wire();
    const r = await run({ buttonLabel: "Go" });
    expect(r.envelope?.error?.code).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(s.posts).toHaveLength(0);
  });

  test("--uuid is required", async () => {
    wire();
    const r = await runCommand(saveCommand, [overlayFile({ summary: "x" }), "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("MISSING_UUID");
  });
});

describe("ad save — validator gate", () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    rule: "M1",
    severity: "error" as const,
    message: "bad",
    path: "outputs[0].key",
    ...over,
  });

  test("errors block with AD_VALIDATION_FAILED; validator sees before/after/overlayPaths", async () => {
    const s = wire();
    let seen: any;
    __setValidatorsForTests({
      offline: (input) => {
        seen = input;
        return { errors: [finding()], warnings: [], layersRun: ["L1", "L2", "L3"] };
      },
    });
    const r = await run({ summary: "x" });
    expect(r.envelope?.error?.code).toBe("AD_VALIDATION_FAILED");
    const d = r.envelope?.error?.details as any;
    expect(d.errors).toHaveLength(1);
    expect(d.layersRun).toEqual(["L1", "L2", "L3"]);
    expect(seen.after.summary).toBe("x");
    expect(seen.before.summary).toBe(base().summary);
    expect(seen.overlayPaths).toEqual(["summary"]);
    expect(s.posts).toHaveLength(0);
  });

  test("warnings pass through to data.validation; --strict blocks new ones, never pre-existing ones", async () => {
    wire();
    __setValidatorsForTests({ offline: () => ({ errors: [], warnings: [finding({ severity: "warn" })], layersRun: ["L1"] }) });
    const ok = await run({ summary: "x" });
    expect(ok.envelope?.ok).toBe(true);
    expect((ok.envelope!.data as any).validation.warnings).toHaveLength(1);
    const blocked = await run({ summary: "y" }, "--strict");
    expect(blocked.envelope?.error?.code).toBe("AD_VALIDATION_FAILED");
    __setValidatorsForTests({
      offline: () => ({ errors: [], warnings: [finding({ severity: "warn", preexisting: true })], layersRun: ["L1"] }),
    });
    const pre = await run({ summary: "z" }, "--strict");
    expect(pre.envelope?.ok).toBe(true);
  });

  test("--no-validate skips the validator (logged) and saves", async () => {
    wire();
    let called = false;
    __setValidatorsForTests({
      offline: () => {
        called = true;
        return { errors: [finding()], warnings: [], layersRun: [] };
      },
    });
    const r = await run({ summary: "x" }, "--no-validate");
    expect(r.envelope?.ok).toBe(true);
    expect(called).toBe(false);
    expect((r.envelope!.data as any).validation.skipped).toBe(true);
  });

  test("--dry-run-compile runs the online validator with the env", async () => {
    wire();
    let env = "";
    __setValidatorsForTests({
      online: async (input) => {
        env = input.env;
        return { errors: [], warnings: [], layersRun: ["L4"] };
      },
    });
    const r = await run({ summary: "x" }, "--dry-run-compile");
    expect(r.envelope?.ok).toBe(true);
    expect(env).toBe("t-dev");
    expect((r.envelope!.data as any).validation.layersRun).toEqual(["L4"]);
  });
});
