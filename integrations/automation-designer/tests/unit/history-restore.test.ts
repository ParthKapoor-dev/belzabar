// `ad history` against the real history wire (fixtures/history, captured from
// belz_tst_s4b_hist1 on acme-dev).
//
// F7: history.get is addressed by category + method name; `includeDraft:"true"`
// returns the DRAFT chain's version N, otherwise the PUBLISHED chain's. `list`
// lists by uuid, so show/diff must pick the side that matches the uuid.
// AD-23: restore goes through the draft guard, fails closed on an unknown
// response, re-fetches and reports the resulting version.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  fakeFetch,
  type FakeFetch,
  jsonFixtures,
  type RecordedRequest,
  respond,
  runCommand,
  type TempEnvConfig,
  withTempEnvConfig,
} from "@belzabar/core/testing";
import historyCommand from "../../commands/history/index";
import { interpretRestoreResponse } from "../../lib/api/v1";
import { logIntent } from "../../lib/args/confirm";

const FIX = join(import.meta.dir, "../fixtures/history");
const load = jsonFixtures(FIX);
const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
const PUB = "0000000000000000000000000000beef";

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

interface WireOpts {
  /** Chain body returned for GET chain/<DRAFT> (v1). Default: the real draft. */
  draftV1?: any;
  /** restore handler; default: the real success answer. */
  restore?: (req: RecordedRequest) => unknown;
  /** V2 chain body served after a restore (default: the real one). */
  draftV2?: any;
  publishedV1?: any;
  /** History.get body for draft version 1 (default: the real one). */
  draftHistV1?: any;
}

/** The history services + chain endpoints. `get` serves the draft fixtures for includeDraft, a "published" body otherwise. */
function wire(opts: WireOpts = {}) {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
  const pubGet = (v: string) => ({ ...load("get-draft-v1.json"), methodID: PUB, methodVersion: Number(v), methodVersionID: `pub-${v}` });
  ff = fakeFetch([
    { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: opts.draftV1 ?? load("chain-v1-draft.json") },
    { method: "GET", url: `/rest/api/automation/chain/${PUB}`, response: opts.publishedV1 ?? { error: "no published fixture" } },
    { method: "GET", url: `/rest/api/automation/chain/v2/${DRAFT}?basicInfo=false`, response: opts.draftV2 ?? load("chain-v2-draft.json") },
    {
      method: "GET",
      url: /automation-systems\/Expertly\.Automation\.Method\.History\/automation-apis\//,
      response: (req: RecordedRequest) => ({ serviceChainUID: `hist-${req.url.split("/").pop()}` }),
    },
    { method: "POST", url: /chain\/execute\/hist-listAll/, response: load("listAll-draft.json") },
    {
      method: "POST",
      url: /chain\/execute\/hist-get/,
      response: (req: RecordedRequest) => {
        const b = req.json();
        if (b.includeDraft !== "true") return pubGet(b.version);
        if (b.version === "1") return opts.draftHistV1 ?? load("get-draft-v1.json");
        if (b.version === "3") return load("get-draft-v3.json");
        return respond({ status: 500, json: load("get-not-found-500.json") });
      },
    },
    { method: "POST", url: /\/cache\/invalidate$/, response: "success" },
    {
      method: "POST",
      url: /chain\/execute\/hist-restore/,
      response: opts.restore ?? (() => ({ response: true, executionStatus: { executed: true, failed: false, statusCode: 200 } })),
    },
  ]).install();
  return ff;
}

const getCalls = (f: FakeFetch) => f.requests.filter((r) => r.url.includes("execute/hist-get")).map((r) => r.json());
const restoreCalls = (f: FakeFetch) => f.requests.filter((r) => r.url.includes("execute/hist-restore"));

describe("ad history show/list version mapping (F7)", () => {
  test("show on a DRAFT uuid reads the draft chain's history (includeDraft) and matches list", async () => {
    const f = wire();
    const list = await runCommand(historyCommand, ["list", DRAFT], { env: "t-dev" });
    const show = await runCommand(historyCommand, ["show", DRAFT, "--version", "3"], { env: "t-dev" });
    expect(show.envelope?.ok).toBe(true);
    const listed = (list.envelope?.data as any).versions.find((v: any) => v.version === 3);
    expect((show.envelope?.data as any).versionUUID).toBe(listed.versionUUID);
    expect((show.envelope?.data as any).side).toBe("DRAFT");
    expect(getCalls(f)).toEqual([{ serviceName: "Test-Tester", methodName: "belz_tst_s4b_hist1", version: "3", includeDraft: "true" }]);
  });

  test("show on a PUBLISHED uuid reads the published chain's history (no includeDraft)", async () => {
    const pub = { ...load("chain-v1-draft.json"), uuid: PUB, automationState: "PUBLISHED", referenceId: DRAFT };
    const f = wire({ publishedV1: pub });
    const show = await runCommand(historyCommand, ["show", PUB, "--version", "2"], { env: "t-dev" });
    expect(show.envelope?.ok).toBe(true);
    expect((show.envelope?.data as any).versionUUID).toBe("pub-2");
    expect((show.envelope?.data as any).side).toBe("PUBLISHED");
    expect(getCalls(f)[0].includeDraft).toBeUndefined();
  });

  test("unknown version -> HISTORY_VERSION_NOT_FOUND (server 500 'No record found.')", async () => {
    wire();
    const r = await runCommand(historyCommand, ["show", DRAFT, "--version", "99"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("HISTORY_VERSION_NOT_FOUND");
  });

  test("diff compares the same records show returns (code change v1 -> v3 is visible)", async () => {
    wire();
    const r = await runCommand(historyCommand, ["diff", DRAFT, "--from", "1", "--to", "3"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.v1StepCount).toBe(1);
    expect(d.steps[0].changed).toBe(true);
    expect(d.steps[0].detail).toBe("Source changed");
  });
});

describe("ad history restore (AD-23)", () => {
  test("success: draft-guarded, restores the draft side, reports resulting version + content match", async () => {
    const f = wire();
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.success).toBe(true);
    expect(d.platformResponse).toBe(true);
    expect(d.uuid).toBe(DRAFT);
    expect(d.resultingVersion).toBe(4); // fixture: the draft after restoring v1
    expect(d.contentMatches).toBe(true); // v4 carries v1's code
    expect(restoreCalls(f)[0]!.json()).toEqual({ serviceName: "Test-Tester", methodName: "belz_tst_s4b_hist1", version: "1", includeDraft: "true" });
  });

  test("a PUBLISHED uuid is refused before any write (versions are per chain)", async () => {
    const pub = { ...load("chain-v1-draft.json"), uuid: PUB, automationState: "PUBLISHED", referenceId: DRAFT };
    const f = wire({ publishedV1: pub });
    const r = await runCommand(historyCommand, ["restore", PUB, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("HISTORY_RESTORE_NEEDS_DRAFT");
    expect(r.envelope?.error?.message).toContain(DRAFT);
    expect(restoreCalls(f)).toHaveLength(0);
  });

  test("unknown state -> draft guard refuses, no write", async () => {
    const noState = load("chain-v1-draft.json");
    delete noState.automationState;
    delete noState.state;
    const f = wire({ draftV1: noState });
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_DRAFT_GUARD_STATE_UNKNOWN");
    expect(restoreCalls(f)).toHaveLength(0);
  });

  test("a version missing from the draft history is refused before the write", async () => {
    const f = wire();
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "99", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("HISTORY_VERSION_NOT_FOUND");
    expect(restoreCalls(f)).toHaveLength(0);
  });

  test("platform false -> ok:false RESTORE_FAILED", async () => {
    wire({ restore: () => ({ response: false, executionStatus: { failed: false } }) });
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("RESTORE_FAILED");
    expect(r.exitCode).not.toBe(0);
  });

  test("unrecognised response + content not verified -> ok:false RESTORE_UNCONFIRMED (fail closed)", async () => {
    // after the "restore", the draft still carries v3's code
    const v2 = load("chain-v2-draft.json");
    const step = v2.steps[0].properties.customCode;
    step.inlineCode = step.inlineCode.replace("v1-content", "v3-content");
    wire({ restore: () => ({ something: "else" }), draftV2: v2 });
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("RESTORE_UNCONFIRMED");
    expect((r.envelope?.data as any).platformResponse).toBeNull();
  });

  test("unrecognised response but verified content -> ok", async () => {
    wire({ restore: () => ({ something: "else" }) });
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).contentMatches).toBe(true);
  });

  test("ADW-R8: platform true but the draft does not carry the target content -> ok:false RESTORE_UNCONFIRMED", async () => {
    const v2 = load("chain-v2-draft.json");
    const step = v2.steps[0].properties.customCode;
    step.inlineCode = step.inlineCode.replace("v1-content", "v3-content");
    wire({ draftV2: v2 }); // default restore answer: true
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("RESTORE_UNCONFIRMED");
    const d = r.envelope?.data as any;
    expect([d.platformResponse, d.contentMatches, d.success]).toEqual([true, false, false]);
  });

  test("ADW-R8 regression: a real V2 GET vs its own history body (GET-only fieldCode, service spelling) -> success", async () => {
    // Real acme-dev 4bfc83c7: the V2 GET spells the category "Schools-Utilities"
    // and adds method-output fieldCode; the history body of the same version
    // says "Schools - Utilities" and has no fieldCode.
    const XF = join(import.meta.dir, "../fixtures");
    const read = (f: string) => JSON.parse(readFileSync(join(XF, f), "utf8"));
    wire({
      draftHistV1: { ...read("cross-env/4bfc83c7fc3da12d7e639ee88a40ff27.acme-dev.history-v3.json"), methodID: DRAFT, isPublished: false },
      draftV2: read("real-v2/4bfc83c7fc3da12d7e639ee88a40ff27.v2.json"),
    });
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error ?? null).toBeNull();
    const d = r.envelope?.data as any;
    expect([d.contentMatches, d.success]).toEqual([true, true]);
  });

  test("ADW-R8: a content mismatch names the differing paths", async () => {
    const v2 = load("chain-v2-draft.json");
    const step = v2.steps[0].properties.customCode;
    step.inlineCode = step.inlineCode.replace("v1-content", "v3-content");
    wire({ draftV2: v2 });
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("RESTORE_UNCONFIRMED");
    expect((r.envelope?.data as any).contentDiff).toEqual(["$.steps[0].properties.customCode.inlineCode"]);
  });

  test("ADW-R8: the compiled cache of the draft is evicted on both routes; the restored body is validated", async () => {
    const f = wire();
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const inv = f.requests.filter((q) => q.url.endsWith("cache/invalidate"));
    expect(inv.map((q) => q.url.replace("https://t-dev.test", ""))).toEqual([
      "/rest/api/cache/invalidate",
      "/rest/api/automations/cache/invalidate",
    ]);
    expect(inv[0]!.json()).toEqual({ uuids: [DRAFT], type: "AUTOMATION" });
    const d = r.envelope?.data as any;
    expect(d.compiledCache.ok).toBe(true);
    expect(Array.isArray(d.validation.errors)).toBe(true);
  });

  test("--llm without --yes -> AD_CONFIRMATION_REQUIRED, no write", async () => {
    const f = wire();
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(restoreCalls(f)).toHaveLength(0);
  });
});

describe("interpretRestoreResponse", () => {
  test("real success wire, false, failed status, unknown shapes", () => {
    expect(interpretRestoreResponse({ response: true, executionStatus: { executed: true, failed: false } })).toBe(true);
    expect(interpretRestoreResponse({ response: "true" })).toBe(true);
    expect(interpretRestoreResponse({ response: false })).toBe(false);
    expect(interpretRestoreResponse({ response: true, executionStatus: { failed: true } })).toBe(false);
    expect(interpretRestoreResponse({ response: { response: true } })).toBe(true);
    expect(interpretRestoreResponse({})).toBeNull();
    expect(interpretRestoreResponse(null)).toBeNull();
    expect(interpretRestoreResponse({ response: [1] })).toBeNull();
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
