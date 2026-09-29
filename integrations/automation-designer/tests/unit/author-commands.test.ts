// Stage 7.2 / 7.3 end to end through the commands (fakeFetch, fake sems-dev
// that mints step ids and fills input types like the real server):
//   ad save  — structural ops, --sql-file / --code-file, --dry-run, verify
//   ad create --spec <compact> — contracts, codeFile/sqlFile, spec.category, --dry-run
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { fakeFetch, fixture, runCommand, scratchDir, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import saveCommand from "../../commands/save/index";
import createCommand from "../../commands/create/index";
import { COMPILED_CACHE_ROUTES } from "../../lib/save/compiled-cache";
import type { V2MethodResponse, V2Step } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;
const ON = `${FIX}/validate/online`;
const API = "/rest/api/automation-systems";
const U = "41bb1b438875bd8b994196db1f12b7c2"; // DRAFT; 1 SQL read, 2 CC plain, 3 SQL add, …
const GET = `/rest/api/automation/chain/v2/${U}?basicInfo=false`;
const NEW = "4d42844c66f687f1226eb020eb10f4db";
const base = (): V2MethodResponse => structuredClone(require(`${FIX}/real-v2/${U}.v2.json`));

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  while (spies.length) spies.pop()!.mockRestore();
});

const contractRoutes = [
  { method: "GET", url: `${API}/Helpers.Legacy/automation-apis/echo`, response: fixture(`${ON}/api-echo.json`) },
  { method: "GET", url: `${API}/db_service/automation-apis/data.read`, response: () => new Response("", { status: 200 }) },
  { method: "GET", url: `${API}/db_service/automation-apis/select`, response: fixture(`${ON}/api-db-select.json`) },
  { method: "GET", url: `${API}/db_service/auth`, response: fixture(`${ON}/auth-db_service.json`) },
];

/** What the real server does to a stored body: mint missing step ids, fill step input types. */
function serverFill(body: V2MethodResponse): V2MethodResponse {
  const out = structuredClone(body);
  let n = 0;
  const fill = (inputs: unknown) => {
    for (const i of (inputs ?? []) as Array<Record<string, unknown>>) {
      i.type ??= "STRING";
      i.uuid ??= `f${String(++n).padStart(31, "0")}    `;
      fill(i.properties);
    }
  };
  for (const s of (out.steps ?? []) as V2Step[]) {
    if (!s.id && s.properties?.type === "EXISTING_SERVICE") s.id = `e${String(++n).padStart(31, "0")}    `;
    fill(s.inputs);
  }
  return out;
}

function setup(): string {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
  const dir = join(scratchDir("ad-author"), Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function wireSave(onStore: (b: V2MethodResponse) => V2MethodResponse = serverFill) {
  const s = { stored: base(), posts: [] as V2MethodResponse[] };
  ff = fakeFetch([
    { method: "GET", url: GET, response: () => structuredClone(s.stored) },
    {
      method: "POST",
      url: "/rest/api/automation/chain/v2",
      response: (req: RecordedRequest) => {
        const body = req.json() as V2MethodResponse;
        s.posts.push(body);
        const next = onStore(body);
        next.metadata.version = { ...next.metadata.version!, name: String(Number(s.stored.metadata.version?.name) + 1) };
        s.stored = next;
        return next;
      },
    },
    ...contractRoutes,
    ...COMPILED_CACHE_ROUTES.map((p) => ({ method: "POST", url: p, response: () => "success" })),
  ]).install();
  return s;
}

const write = (dir: string, name: string, content: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
};

describe("ad save — structural ops", () => {
  test("ops + --sql-file + --code-file: one POST of the rearranged body, verified on re-read", async () => {
    const dir = setup();
    const s = wireSave();
    const overlay = write(dir, "ov.json", {
      summary: "structural",
      ops: [
        { op: "set-variable", key: "greeting" },
        { op: "add-step", after: 1, step: { service: "Helpers.Legacy/echo", inputs: { Input: "Hi #{code}" }, outputs: [{ key: "response", as: "greetOut", var: "greeting" }] } },
        { op: "move-step", step: 3, before: 2 },
        { op: "remove-step", step: 11 },
      ],
    });
    const sql = write(dir, "q.sql", "SELECT 7 AS seven");
    const js = write(dir, "c.js", "console.log(JSON.stringify({code_value: 1}))");
    const r = await runCommand(saveCommand, [overlay, "--uuid", U, "--sql-file", `1=${sql}`, "--code-file", `2=${js}`, "--yes"], { env: "t-dev" });
    expect(r.envelope?.error ?? null).toBeNull();
    const d = r.envelope!.data as any;
    expect(d.applied).toEqual([
      "summary",
      "set-variable greeting (new)",
      "add-step Helpers.Legacy/echo after 1",
      "move-step 3 before 2",
      "remove-step 11",
      "update-step 1 (sql)",
      "update-step 2 (code)",
    ]);
    expect(s.posts).toHaveLength(1);
    const sent = s.posts[0]!;
    const live = base();
    expect(sent.metadata).toEqual(live.metadata);
    expect(sent.steps!.map((x): unknown => x.id ?? x.serviceName ?? "cc")).toEqual([
      live.steps![0]!.id, "Helpers.Legacy", live.steps![2]!.id, "cc", ...live.steps!.slice(3, 10).map((x) => x.id),
    ]);
    expect((sent.steps![0]!.inputs![0]!.properties as Array<{ key: string; value: string }>).find((x) => x.key === "queryString")!.value).toBe("SELECT 7 AS seven");
    expect(sent.steps![3]!.properties!.customCode!.inlineCode).toBe("console.log(JSON.stringify({code_value: 1}))");
    expect(d.compiledCache.ok).toBe(true);
  });

  test("--dry-run plans and validates, POSTs nothing, reports the new order", async () => {
    const dir = setup();
    const s = wireSave();
    const overlay = write(dir, "ov.json", { ops: [{ op: "move-step", step: 2, after: 3 }, { op: "remove-step", step: 11 }] });
    const r = await runCommand(saveCommand, [overlay, "--uuid", U, "--dry-run"], { env: "t-dev" });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(r.envelope!.data).toMatchObject({ action: "DRY_RUN", draftUuid: U, valid: true, applied: ["move-step 2 after 3", "remove-step 11"], order: [1, 3, 2, 4, 5, 6, 7, 8, 9, 10] });
    // Removing step 5 orphans #{existing_code_list} (read by step 7): reported as data, still nothing written.
    const broken = write(dir, "ov2.json", { ops: [{ op: "remove-step", step: 5 }] });
    const r2 = await runCommand(saveCommand, [broken, "--uuid", U, "--dry-run"], { env: "t-dev" });
    expect(r2.envelope?.ok).toBe(true);
    expect((r2.envelope!.data as any).valid).toBe(false);
    expect((r2.envelope!.data as any).validation.errors.map((f: any) => f.rule)).toContain("AD-REF-001");
    expect(s.posts).toHaveLength(0);
    expect(ff!.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  test("a server that drops an added step's input → AD_SAVE_VERIFY_FAILED naming the path", async () => {
    const dir = setup();
    wireSave((b) => {
      const out = serverFill(b);
      out.steps![1]!.inputs = [];
      return out;
    });
    const overlay = write(dir, "ov.json", { ops: [{ op: "add-step", after: 1, step: { service: "Helpers.Legacy/echo", inputs: { Input: "x" }, outputs: ["response"] } }] });
    const r = await runCommand(saveCommand, [overlay, "--uuid", U, "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_SAVE_VERIFY_FAILED");
    expect((r.envelope!.error!.details as any).notLanded.map((n: any) => n.path)).toEqual(["steps[1].inputs[0]"]);
  });

  test("a server that reorders untouched steps → AD_SAVE_VERIFY_FAILED (unexpected)", async () => {
    const dir = setup();
    wireSave((b) => {
      const out = serverFill(b);
      const st = out.steps!;
      [st[5], st[6]] = [st[6]!, st[5]!];
      return out;
    });
    const overlay = write(dir, "ov.json", { ops: [{ op: "remove-step", step: 11 }] });
    const r = await runCommand(saveCommand, [overlay, "--uuid", U, "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_SAVE_VERIFY_FAILED");
    expect((r.envelope!.error!.details as any).unexpected.length).toBeGreaterThan(0);
  });

  test("--sql-file on a custom-code step is refused before anything is written; bad N=path → INVALID_VALUE", async () => {
    const dir = setup();
    const s = wireSave();
    const sql = write(dir, "q.sql", "SELECT 1");
    const r = await runCommand(saveCommand, ["--uuid", U, "--sql-file", `2=${sql}`, "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(s.posts).toHaveLength(0);
    const bad = await runCommand(saveCommand, ["--uuid", U, "--sql-file", "q.sql", "--yes"], { env: "t-dev" });
    expect(bad.envelope?.error?.code).toBe("INVALID_VALUE");
    const missing = await runCommand(saveCommand, ["--uuid", U, "--code-file", `2=${join(dir, "nope.js")}`, "--yes"], { env: "t-dev" });
    expect(missing.envelope?.error?.code).toBe("FILE_NOT_FOUND");
  });

  test("codeFile/sqlFile inside the overlay resolve relative to the overlay file", async () => {
    const dir = setup();
    const s = wireSave();
    mkdirSync(join(dir, "src"));
    write(dir, "src/c.js", "console.log(JSON.stringify({code_value: 2}))");
    const overlay = write(dir, "ov.json", { ops: [{ op: "update-step", step: 2, set: { codeFile: "src/c.js" } }] });
    const r = await runCommand(saveCommand, [overlay, "--uuid", U, "--yes"], { env: "t-dev" });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(s.posts[0]!.steps![1]!.properties!.customCode!.inlineCode).toBe("console.log(JSON.stringify({code_value: 2}))");
    const both = write(dir, "ov2.json", { ops: [{ op: "update-step", step: 2, set: { code: "x", codeFile: "src/c.js" } }] });
    expect((await runCommand(saveCommand, [both, "--uuid", U, "--yes"], { env: "t-dev" })).envelope?.error?.code).toBe("AD_OVERLAY_INVALID");
  });
});

function wireCreate() {
  let stored: V2MethodResponse | null = null;
  ff = fakeFetch([
    { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=false", response: fixture(`${FIX}/categories/chain-category.json`) },
    { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=true", response: fixture(`${FIX}/categories/chain-category-system.json`) },
    {
      method: "POST",
      url: "/rest/api/automation/chain/v2",
      response: (req: RecordedRequest) => {
        const b = serverFill(req.json() as V2MethodResponse);
        stored = { ...b, uuid: NEW, metadata: { ...b.metadata, state: "DRAFT", referenceId: null, version: { name: "1" }, service: { ...b.metadata.service!, description: "" } as never } };
        return stored;
      },
    },
    { method: "GET", url: `/rest/api/automation/chain/v2/${NEW}?basicInfo=false`, response: () => stored },
    ...contractRoutes,
  ]).install();
}

const compactSpec = {
  name: "belz_tst_s7b_unit",
  category: "Test-Parth",
  inputs: [{ key: "name", required: true, default: "World" }],
  variables: ["greeting"],
  outputs: ["greeting", "len", { key: "rows", type: "ARRAY" }],
  steps: [
    { service: "Helpers.Legacy/echo", inputs: { Input: "Hello #{name}" }, outputs: [{ key: "response", as: "greetingOut", var: "greeting" }] },
    { codeFile: "len.js", outputs: ["len"] },
    { sqlFile: "rows.sql", account: 2, outputs: { rows: "flatData[]" }, when: "#{name} ne null" },
  ],
};

describe("ad create --spec (compact)", () => {
  test("expands, validates, creates and verifies every value read back; spec.category used", async () => {
    const dir = setup();
    wireCreate();
    write(dir, "len.js", "console.log('#{greeting}'.length)");
    write(dir, "rows.sql", "SELECT 1 AS one");
    const r = await runCommand(createCommand, ["--spec", write(dir, "spec.json", compactSpec), "--yes"], { env: "t-dev" });
    expect(r.envelope?.error ?? null).toBeNull();
    expect(r.envelope!.data).toMatchObject({ uuid: NEW, name: "belz_tst_s7b_unit", stepCount: 3, category: { chainCategoryId: 1135 } });
    const post = ff!.requests.find((q) => q.method === "POST")!.json() as V2MethodResponse;
    expect(post.steps!.map((s) => `${s.serviceName ?? "CC"}/${s.methodName ?? ""}`)).toEqual(["Helpers.Legacy/echo", "CC/", "db_service/data.read"]);
    expect(post.steps![1]!.properties!.customCode!.inlineCode).toBe("console.log('#{greeting}'.length)");
    expect(post.steps![2]!.accountConfiguration).toEqual({ id: 2, name: "BCPS-RDS" });
    expect(post.inputs![0]).toMatchObject({ key: "name", required: true, defaultValue: "World" });
  });

  test("--dry-run returns the expanded body and validation, POSTs nothing, needs no --yes; invalid specs report errors", async () => {
    const dir = setup();
    wireCreate();
    write(dir, "len.js", "console.log(1)");
    write(dir, "rows.sql", "SELECT 1");
    const r = await runCommand(createCommand, ["--spec", write(dir, "spec.json", compactSpec), "--dry-run"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope!.data as any;
    expect(d).toMatchObject({ dryRun: true, valid: true, category: { chainCategoryId: 1135 } });
    expect(d.body.steps).toHaveLength(3);
    expect(ff!.requests.filter((q) => q.method === "POST")).toHaveLength(0);
    // A method output nothing writes (M3) → valid:false with the finding, still no POST.
    const bad = { ...compactSpec, outputs: [...compactSpec.outputs, "ghost"] };
    const r2 = await runCommand(createCommand, ["--spec", write(dir, "bad.json", bad), "--dry-run"], { env: "t-dev" });
    expect(r2.envelope?.ok).toBe(true);
    expect((r2.envelope!.data as any).valid).toBe(false);
    expect((r2.envelope!.data as any).validation.errors.map((f: any) => f.rule)).toContain("M3");
  });

  test("refusals: flag/spec category conflict, unknown compact key, unknown service, unknown input key", async () => {
    const dir = setup();
    wireCreate();
    write(dir, "len.js", "console.log(1)");
    write(dir, "rows.sql", "SELECT 1");
    const run = (spec: unknown, ...extra: string[]) => runCommand(createCommand, ["--spec", write(dir, `s${Math.random()}.json`, spec), "--yes", ...extra], { env: "t-dev" });
    expect((await run(compactSpec, "--category", "Schools")).envelope?.error?.code).toBe("AD_SPEC_INVALID");
    expect((await run({ ...compactSpec, steps: [{ service: "Helpers.Legacy/echo", colour: 1 }] })).envelope?.error?.code).toBe("AD_SPEC_UNKNOWN_KEY");
    expect((await run({ ...compactSpec, steps: [{ service: "Helpers.Legacy/echo", inputs: { input: "x" } }] })).envelope?.error?.code).toBe("AD_SPEC_NOT_APPLIED");
    expect((await run({ ...compactSpec, inputs: [{ key: "a", testValue: "x" }] })).envelope?.error?.code).toBe("AD_SPEC_INVALID");
    expect(ff!.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });
});

describe("ad save — methods with test cases (testSuite)", () => {
  // Live sems-dev 2026-09-29: a V2 POST carrying testSuite makes the server rebuild the
  // suite (new assertion ids, createdOn/updatedOn, chainVersionId); without it the suite
  // is kept and only its updatedOn moves. Either way the re-read suite differs from the
  // body belz sent, which used to fail every save with AD_SAVE_VERIFY_FAILED.
  function wireSuiteServer() {
    const s = { stored: base(), posts: [] as V2MethodResponse[] };
    expect((s.stored as any).testSuite.testCases).toHaveLength(2);
    ff = fakeFetch([
      {
        method: "GET",
        url: GET,
        response: () => structuredClone(s.stored),
      },
      {
        method: "POST",
        url: "/rest/api/automation/chain/v2",
        response: (req: RecordedRequest) => {
          const body = req.json() as any;
          s.posts.push(body);
          const prevSuite = structuredClone((s.stored as any).testSuite);
          const next = serverFill(body) as any;
          if (body.testSuite) {
            next.testSuite.chainVersionId = 2; // rebuilt from the sent copy
            for (const c of next.testSuite.testCases) for (const a of c.assertions ?? []) a.id = `rebuilt-${a.id}`;
          } else next.testSuite = { ...prevSuite, updatedOn: 1790663918718 };
          next.metadata.version = { ...next.metadata.version, name: String(Number(s.stored.metadata.version?.name) + 1) };
          s.stored = next;
          return next;
        },
      },
      ...contractRoutes,
      ...COMPILED_CACHE_ROUTES.map((p) => ({ method: "POST", url: p, response: () => "success" })),
    ]).install();
    return s;
  }

  test("the suite is never sent (so never rebuilt) and its bookkeeping does not fail the verify", async () => {
    const dir = setup();
    const s = wireSuiteServer();
    const before = structuredClone((s.stored as any).testSuite);
    for (const overlay of [{ summary: "leaf edit" }, { ops: [{ op: "remove-step", step: 11 }] }]) {
      const r = await runCommand(saveCommand, [write(dir, `o${Math.random()}.json`, overlay), "--uuid", U, "--yes"], { env: "t-dev" });
      expect(r.envelope?.error ?? null).toBeNull();
      expect(s.posts.at(-1)).not.toHaveProperty("testSuite");
    }
    const after = (s.stored as any).testSuite;
    expect({ ...after, updatedOn: undefined }).toEqual({ ...before, updatedOn: undefined });
  });

  test("a suite changed by someone else between read and save is not a version conflict", async () => {
    const dir = setup();
    const s = wireSuiteServer();
    let gets = 0;
    ff!.restore();
    ff = fakeFetch([
      {
        method: "GET",
        url: GET,
        response: () => {
          const b = structuredClone(s.stored) as any;
          if (++gets >= 2) b.testSuite.testCases.push({ id: "new", name: "added.meanwhile", inputs: [], assertions: [] });
          return b;
        },
      },
      {
        method: "POST",
        url: "/rest/api/automation/chain/v2",
        response: (req: RecordedRequest) => (s.stored = { ...serverFill(req.json() as V2MethodResponse), testSuite: (s.stored as any).testSuite }),
      },
      ...COMPILED_CACHE_ROUTES.map((p) => ({ method: "POST", url: p, response: () => "success" })),
    ]).install();
    const r = await runCommand(saveCommand, [write(dir, "o.json", { summary: "x" }), "--uuid", U, "--yes"], { env: "t-dev" });
    expect(r.envelope?.error ?? null).toBeNull();
  });
});
