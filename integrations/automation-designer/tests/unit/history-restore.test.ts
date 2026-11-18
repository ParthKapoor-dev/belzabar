// `ad history` against the real history wire (fixtures/history, captured from
// belz_tst_s4b_hist1 on acme-dev).
//
// history.get is addressed by category + method name; `includeDraft:"true"`
// returns the DRAFT chain's version N, otherwise the PUBLISHED chain's. `list`
// lists by uuid, so show/diff must pick the side that matches the uuid.
// restore goes through the draft guard, fails closed on an unknown
// response, re-fetches and reports the resulting version.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  type FakeFetch,
  jsonFixtures,
  type RecordedRequest,
  respond,
  runCommand,
  withTempEnvConfig
} from "@belzabar/core/testing";
import historyCommand from "../../commands/history/index";
import { interpretRestoreResponse } from "../../lib/api/v1";
import { logIntent } from "../../lib/args/confirm";
import { fakeAdEnv, historyServiceRoute } from "./helpers/fake-ad";
import { lineDiff } from "../../lib/text-diff";
import { historyTimeIso } from "../../lib/history";

describe("lineDiff / historyTimeIso", () => {
  test("hunks keep 2 lines of context; distant changes are separate hunks; equal text is []", () => {
    const a = ["select a", "from t", "where x = 1", "and y = 2", "l5", "l6", "l7", "l8", "l9", "order by a"].join("\n");
    const b = ["select a, b", "from t", "where x = 1", "and y = 2", "l5", "l6", "l7", "l8", "l9", "order by b"].join("\n");
    expect(lineDiff(a, a)).toEqual([]);
    expect(lineDiff(a, b)).toEqual([
      "@@ -1,3 +1,3 @@", "-select a", "+select a, b", " from t", " where x = 1",
      "@@ -8,3 +8,3 @@", " l8", " l9", "-order by a", "+order by b",
    ]);
    expect(lineDiff("x\ny", "x\nnew\ny")).toEqual(["@@ -1,2 +1,3 @@", " x", "+new", " y"]);
  });

  test("the platform's zone-less history time is UTC", () => {
    expect(historyTimeIso("2026-11-10 10:00:56.688")).toBe("2026-11-10T10:00:56.688Z");
    expect(historyTimeIso("not a date")).toBe("not a date");
  });
});

const FIX = join(import.meta.dir, "../fixtures/history");
const load = jsonFixtures(FIX);
const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
const PUB = "0000000000000000000000000000beef";

const ad = fakeAdEnv();
afterEach(() => ad.restore());

interface WireOpts {
  /** Chain body returned for GET chain/<DRAFT> (v1). Default: the real draft. */
  draftV1?: any;
  /** restore handler; default: the real success answer. */
  restore?: (req: RecordedRequest) => unknown;
  /** V2 chain body served after a restore (default: the real one). */
  draftV2?: any;
  publishedV1?: any;
  /** Extra routes (e.g. the test-case PUT). */
  extra?: Array<{ method?: string; url: string | RegExp; response: unknown }>;
  /** History.get body for draft version 1 (default: the real one). */
  draftHistV1?: any;
}

/** The history services + chain endpoints. `get` serves the draft fixtures for includeDraft, a "published" body otherwise. */
function wire(opts: WireOpts = {}) {
  const pubGet = (v: string) => ({ ...load("get-draft-v1.json"), methodID: PUB, methodVersion: Number(v), methodVersionID: `pub-${v}` });
  ad.install([
    { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: opts.draftV1 ?? load("chain-v1-draft.json") },
    { method: "GET", url: `/rest/api/automation/chain/${PUB}`, response: opts.publishedV1 ?? { error: "no published fixture" } },
    { method: "GET", url: `/rest/api/automation/chain/v2/${DRAFT}?basicInfo=false`, response: opts.draftV2 ?? load("chain-v2-draft.json") },
    historyServiceRoute(),
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
    ...(opts.extra ?? []),
  ]);
  return ad.ff;
}

const getCalls = (f: FakeFetch) => f.requests.filter((r) => r.url.includes("execute/hist-get")).map((r) => r.json());
const restoreCalls = (f: FakeFetch) => f.requests.filter((r) => r.url.includes("execute/hist-restore"));

describe("ad history show/list version mapping", () => {
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

describe("history list / diff / show output (D20, D21, D32, D38)", () => {
  test("`ad history <uuid>` is `ad history list <uuid>`; junk is still INVALID_ACTION", async () => {
    wire();
    const r = await runCommand(historyCommand, [DRAFT], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).action).toBe("list");
    expect((await runCommand(historyCommand, ["lsit", DRAFT], { env: "t-dev" })).envelope?.error?.code).toBe("INVALID_ACTION");
  });

  test("list: addedWhen is ISO UTC, the platform text stays in addedWhenText; updatedOn is the method's last save", async () => {
    wire();
    const d = (await runCommand(historyCommand, ["list", DRAFT], { env: "t-dev" })).envelope?.data as any;
    expect(d.versions[0]).toMatchObject({ version: 1, addedWhen: "2026-09-27T18:28:34.874Z", addedWhenText: "2026-09-27 18:28:34.874" });
    expect(d.updatedOn).toBe(new Date(1790533744369).toISOString());
    expect(d.historyEmpty).toBeUndefined();
  });

  test("list with no saved versions: historyEmpty with a note naming the last save", async () => {
    ad.install([
      { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: load("chain-v1-draft.json") },
      historyServiceRoute(),
      { method: "POST", url: /chain\/execute\/hist-listAll/, response: { response: [] } },
    ]);
    const d = (await runCommand(historyCommand, ["list", DRAFT], { env: "t-dev" })).envelope?.data as any;
    expect(d).toMatchObject({ totalVersions: 0, historyEmpty: true, updatedOn: new Date(1790533744369).toISOString() });
    expect(d.note).toContain("History empty");
    expect(d.note).toContain(d.updatedOn);
  });

  test("diff: the changed code comes as unified hunks in textDiff", async () => {
    wire();
    const d = (await runCommand(historyCommand, ["diff", DRAFT, "--from", "1", "--to", "3"], { env: "t-dev" })).envelope?.data as any;
    const td: string[] = d.steps[0].textDiff;
    expect(td[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(td.some((l) => l.startsWith("+") && l.includes("v3-content"))).toBe(true);
    expect(td.some((l) => l.startsWith("-"))).toBe(true);
  });

  test("diff: a step that differs only in ids and base64 encoding is not changed (B86)", async () => {
    const v3 = load("get-draft-v3.json");
    const same = structuredClone(v3);
    same.methodVersion = 1;
    for (const s of same.jsonDefinition.steps) {
      s.id = "4fffffffffffffffffffffffffffffff";
      s.properties.customCode.inlineCode = Buffer.from(s.properties.customCode.inlineCode).toString("base64");
    }
    wire({ draftHistV1: same });
    const d = (await runCommand(historyCommand, ["diff", DRAFT, "--from", "1", "--to", "3"], { env: "t-dev" })).envelope?.data as any;
    expect(d.steps.map((s: any) => s.changed)).toEqual(d.steps.map(() => false));
  });

  test("show --code returns the bodies as blocks, the shape of `ad show --compact --code`", async () => {
    wire();
    const d = (await runCommand(historyCommand, ["show", DRAFT, "--version", "3", "--code"], { env: "t-dev" })).envelope?.data as any;
    expect(d.blocks).toEqual([expect.objectContaining({ step: 1, text: 'const g = "v3-content";\nconsole.log(g);' })]);
    expect(d.addedWhen).toMatch(/Z$/);
  });
});

describe("ad history restore", () => {
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

  test("the test cases the restore rewrote are put back (A8); --keep-case-changes keeps them", async () => {
    const suite = (inputs: Array<{ fieldCode: string; value: string }>) => ({
      ...load("chain-v2-draft.json"),
      testSuite: { id: "s1", testCases: [{ id: "c1", name: "case.1", description: "", active: true, inputs, assertions: [] }] },
    });
    for (const keep of [false, true]) {
      // the restore brings back the version's copy of the suite, filled with {}
      let stored = suite([{ fieldCode: "a", value: '{"value": 1}' }]);
      const puts: any[] = [];
      wire({
        draftV2: () => stored,
        restore: () => {
          stored = suite([{ fieldCode: "a", value: '{"value": 9}' }, { fieldCode: "b", value: "{}" }]);
          return { response: true, executionStatus: { executed: true, failed: false, statusCode: 200 } };
        },
        extra: [
          {
            method: "PUT",
            url: /\/chain\/testcases\//,
            response: (req: RecordedRequest) => {
              puts.push(req.json());
              stored = suite(req.json().inputs);
              return {};
            },
          },
        ],
      });
      const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes", ...(keep ? ["--keep-case-changes"] : [])], { env: "t-dev" });
      expect(r.envelope?.ok).toBe(true);
      const t = (r.envelope?.data as any).testCases;
      expect(t.changedByServer).toEqual(["case.1"]);
      if (keep) {
        expect(t).toMatchObject({ restored: [], kept: true });
        expect(puts).toHaveLength(0);
      } else {
        expect(t).toEqual({ changedByServer: ["case.1"], restored: ["case.1"], failed: [] });
        expect(puts[0].inputs).toEqual([{ fieldCode: "a", value: '{"value":1}', defaultValue: '{"value":1}' }]);
      }
    }
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

  test("platform true but the draft does not carry the target content -> ok:false RESTORE_UNCONFIRMED", async () => {
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

  test("a real V2 GET vs its own history body (GET-only fieldCode, service spelling) -> success", async () => {
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

  test("a content mismatch names the differing paths", async () => {
    const v2 = load("chain-v2-draft.json");
    const step = v2.steps[0].properties.customCode;
    step.inlineCode = step.inlineCode.replace("v1-content", "v3-content");
    wire({ draftV2: v2 });
    const r = await runCommand(historyCommand, ["restore", DRAFT, "--version", "1", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("RESTORE_UNCONFIRMED");
    expect((r.envelope?.data as any).contentDiff).toEqual(["$.steps[0].properties.customCode.inlineCode"]);
  });

  test("the compiled cache of the draft is evicted on both routes; the restored body is validated", async () => {
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

describe("logIntent", () => {
  test("reports the active env, not WI_IMPL_ENV", () => {
    using _cfg = withTempEnvConfig({
      envs: { "t-dev": { url: "https://t.test" }, "t-qa": { url: "https://q.test" } },
      activeEnv: "t-qa",
    });
    const prev = process.env.WI_IMPL_ENV;
    process.env.WI_IMPL_ENV = "t-dev";
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      logIntent("POST", "x");
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.WI_IMPL_ENV;
      else process.env.WI_IMPL_ENV = prev;
    }
    expect(writes.join("")).toContain('"env":"t-qa"');
  });
});
