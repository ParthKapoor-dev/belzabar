// `ad publish` + `ad changelog --note`.
// publish first, then the note (retried); a failed publish leaves no
// note; the note id is found from the list (the POST answers {"success":true},
// no id — live). An unknown uuid is a clean METHOD_NOT_FOUND.
// `changelog --note` confirms and records on the draft chain.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { CliError } from "@belzabar/core";
import {
  respond,
  runCommand,
  type FakeFetch,
  type RecordedRequest
} from "@belzabar/core/testing";
import publishCommand, { __setNoteRetryDelayForTests, NOTE_ATTEMPTS } from "../../commands/publish/index";
import changelogCommand from "../../commands/changelog/index";
import { findChangelogId } from "../../lib/api/changelog";
import { __setValidatorsForTests } from "../../lib/save/validation";
import { fetchContractEntry } from "../../lib/validate/online";
import { fakeAdEnv } from "./helpers/fake-ad";

const FIX = join(import.meta.dir, "../fixtures/history");
const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
const PUB = "0000000000000000000000000000beef";
const DRAFT_ID = 20136;
const PUB_ID = 20999;
const draftBody = () => JSON.parse(readFileSync(join(FIX, "chain-v1-draft.json"), "utf8"));
const draftV2 = () => JSON.parse(readFileSync(join(FIX, "chain-v2-draft.json"), "utf8"));

beforeAll(() => __setNoteRetryDelayForTests(0));
const ad = fakeAdEnv();
afterEach(() => {
  ad.restore();
  __setValidatorsForTests();
});

interface Opts {
  publish?: (req: RecordedRequest) => unknown;
  changelogPost?: (req: RecordedRequest, notes: any[]) => unknown;
  published?: boolean; // draft already linked to PUB
  /** V2 GET bodies of the draft / published side (default: the history fixture). */
  draftV2?: () => unknown;
  publishedV2?: () => unknown;
  /** Test suite GET bodies (default: no suite). */
  suites?: Record<string, () => unknown>;
}

/** Change notes per chain id, as the server keeps them (one changelog per chain). */
let chains: Record<string, any[]> = {};
const chainOf = (req: RecordedRequest) => req.url.match(/changelog\/(\d+)$/)![1]!;

function wire(opts: Opts = {}) {
  chains = {};
  const notesOf = (req: RecordedRequest) => (chains[chainOf(req)] ??= []);
  let published = !!opts.published;
  ad.install([
    {
      method: "GET",
      url: `/rest/api/automation/chain/${DRAFT}`,
      response: () => ({ ...draftBody(), referenceId: published ? PUB : null }),
    },
    {
      method: "GET",
      url: `/rest/api/automation/chain/${PUB}`,
      response: () => ({ ...draftBody(), uuid: PUB, id: PUB_ID, automationState: "PUBLISHED", referenceId: DRAFT }),
    },
    { method: "GET", url: `/rest/api/automation/chain/v2/${DRAFT}?basicInfo=false`, response: () => (opts.draftV2 ?? draftV2)() },
    {
      method: "GET",
      url: `/rest/api/automation/chain/v2/${PUB}?basicInfo=false`,
      response: () =>
        opts.publishedV2?.() ?? { ...draftV2(), uuid: PUB, metadata: { ...draftV2().metadata, state: "PUBLISHED", referenceId: DRAFT } },
    },
    { method: "POST", url: /\/cache\/invalidate$/, response: "success" },
    { method: "GET", url: "/rest/api/users/me", response: { user: { id: 2, fullName: "Test User" } } },
    {
      method: "POST",
      url: `/rest/api/automation/chain/${DRAFT}/publish`,
      response:
        opts.publish ??
        (() => {
          published = true;
          return { referenceId: PUB };
        }),
    },
    {
      method: "POST",
      url: /\/chain\/changelog\/\d+$/,
      response: (req: RecordedRequest) => {
        const notes = notesOf(req);
        if (opts.changelogPost) return opts.changelogPost(req, notes);
        const b = req.json();
        notes.push({ id: `note-${chainOf(req)}-${notes.length + 1}`, comment: b.comment, changelogType: b.changelogType, createdAt: b.createdAt });
        return { success: true };
      },
    },
    { method: "GET", url: /\/chain\/changelog\/\d+$/, response: (req: RecordedRequest) => notesOf(req) },
    {
      method: "GET",
      url: /\/chain\/testsuite\/service-chain\/[0-9a-f]{32}$/,
      response: (req: RecordedRequest) => opts.suites?.[req.url.slice(-32)]?.() ?? respond({ status: 200, text: "" }),
    },
  ]);
  return ad.ff;
}

const posts = (f: FakeFetch) =>
  f.requests
    .filter((r) => r.method === "POST" && !r.url.endsWith("cache/invalidate"))
    .map((r) => r.url.replace("https://t-dev.test", ""));

describe("ad publish", () => {
  test("publishes first, then records the note on the draft AND published chains; reports both ids read back", async () => {
    const f = wire();
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(posts(f)).toEqual([
      `/rest/api/automation/chain/${DRAFT}/publish`,
      `/rest/api/automation/chain/changelog/${DRAFT_ID}`,
      `/rest/api/automation/chain/changelog/${PUB_ID}`,
    ]);
    const d = r.envelope?.data as any;
    expect(d.noteRecorded).toBe(true);
    expect(d.changelogId).toBe(`note-${DRAFT_ID}-1`);
    expect(d.noteChainId).toBe(DRAFT_ID);
    expect([d.publishedChangelogId, d.publishedNoteChainId]).toEqual([`note-${PUB_ID}-1`, PUB_ID]);
    expect(d.publishedUuid).toBe(PUB);
    expect(d.inSync).toBe(true); // same logic on both sides
  });

  test("C4: a publish drops the method's own cached callee contract", async () => {
    wire();
    const contract = `/rest/api/automation-systems/Test-Tester/automation-apis/belz_tst_s4b_hist1`;
    ad.ff.add([{ method: "GET", url: contract, response: () => ({ id: 1, uuid: "c", automationUserInputs: [] }) }]);
    await fetchContractEntry("Test-Tester", "belz_tst_s4b_hist1"); // cached now
    expect((await fetchContractEntry("Test-Tester", "belz_tst_s4b_hist1")).cachedAt).not.toBeNull();
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((await fetchContractEntry("Test-Tester", "belz_tst_s4b_hist1")).cachedAt).toBeNull();
  });

  test("publish failure -> no note posted", async () => {
    const f = wire({ publish: () => respond({ status: 500, json: { message: "boom" } }) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(posts(f).filter((p) => p.includes("changelog"))).toHaveLength(0);
  });

  test("note failure after publish -> retried, ok:true with noteRecorded:false and a warning", async () => {
    const f = wire({ changelogPost: () => respond({ status: 503, text: "unavailable" }) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.noteRecorded).toBe(false);
    expect(d.changelogId).toBeNull();
    expect(posts(f).filter((p) => p.includes("changelog"))).toHaveLength(NOTE_ATTEMPTS);
    expect(JSON.stringify(r.envelope?.meta ?? {}) + r.stderr).toContain("NOT recorded");
  });

  test("NEW-1: a note POST that may have completed (reset after send) is not re-sent; found in the list -> recorded", async () => {
    const f = wire({
      changelogPost: (req, notes) => {
        const b = req.json();
        notes.push({ id: "note-x", comment: b.comment, changelogType: b.changelogType, createdAt: b.createdAt });
        throw new Error("ECONNRESET"); // the server stored it; the answer never arrived
      },
    });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(posts(f).filter((p) => p.endsWith(`changelog/${DRAFT_ID}`))).toHaveLength(1);
    const d = r.envelope?.data as any;
    expect([d.noteRecorded, d.changelogId]).toEqual([true, "note-x"]);
  });

  test("NEW-1: may-have-completed and not in the list -> one POST, noteRecorded:false, says check before re-recording", async () => {
    const f = wire({ changelogPost: () => { throw new Error("ECONNRESET"); } });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(posts(f).filter((p) => p.includes("changelog"))).toHaveLength(1); // nothing on the published chain either
    const d = r.envelope?.data as any;
    expect(d.noteRecorded).toBe(false);
    expect(d.noteError).toContain("may have been recorded");
  });

  test("{success:false} from the changelog POST is a failure, not a recorded note", async () => {
    wire({ changelogPost: () => ({ success: false }) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect((r.envelope?.data as any).noteRecorded).toBe(false);
  });

  test("C6: a POST that answers success but never lands is not reported as recorded", async () => {
    wire({ changelogPost: () => ({ success: true }) }); // accepted, nothing stored
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect([d.noteRecorded, d.changelogId, d.publishedChangelogId]).toEqual([false, null, null]);
    expect(d.noteError).toContain("not in the draft's changelog when read back");
    expect(JSON.stringify(r.envelope?.meta)).toContain("NOT recorded");
  });

  test("C6: on the draft but not on the published copy -> noteRecorded:false, says when it appears there", async () => {
    wire({
      changelogPost: (req, notes) => {
        if (chainOf(req) === String(PUB_ID)) return respond({ status: 503, text: "unavailable" });
        const b = req.json();
        notes.push({ id: "on-draft", comment: b.comment, changelogType: b.changelogType, createdAt: b.createdAt });
        return { success: true };
      },
    });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect([d.noteRecorded, d.changelogId, d.publishedChangelogId]).toEqual([false, "on-draft", null]);
    expect(d.noteError).toContain("not in the published copy's changelog");
    // already on the draft: the warning does not tell you to record it again
    expect(JSON.stringify(r.envelope?.meta)).not.toContain("Record it with");
  });

  test("C6: a note already on the published chain is not posted twice", async () => {
    const f = wire();
    chains[String(PUB_ID)] = [{ id: "copied", comment: "ship it", changelogType: "USER_GENERATED", createdAt: Date.now() + 1000 }];
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(posts(f).filter((p) => p.endsWith(`changelog/${PUB_ID}`))).toHaveLength(0);
    expect((r.envelope?.data as any).publishedChangelogId).toBe("copied");
    expect(chains[String(PUB_ID)]).toHaveLength(1);
  });

  test("C26: stage lines on stderr; a client timeout on the publish says to check `ad state` before retrying", async () => {
    wire({ publish: () => { throw new CliError("Request timed out after 300s.", { code: "HTTP_TIMEOUT", details: { mayHaveCompleted: true, retryable: false } }); } });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("HTTP_TIMEOUT");
    expect(r.envelope?.error?.message).toContain(`wi-impl ad state ${DRAFT} --env t-dev`);
    expect((r.envelope?.error?.details as any).mayHaveCompleted).toBe(true);
    expect(r.stderr).toContain("[wi-impl ad publish] validating draft");
    expect(r.stderr).toContain("[wi-impl ad publish] publishing");
  });

  test("unknown uuid -> METHOD_NOT_FOUND before any write", async () => {
    ad.install({ "GET /rest/api/automation/chain/*": respond({ status: 200, text: "" }) });
    const r = await runCommand(publishCommand, ["00000000000000000000000000000000", "--note", "x", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("METHOD_NOT_FOUND");
    expect(ad.ff.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });
});

describe("ad changelog --note", () => {
  test("--llm without --yes -> AD_CONFIRMATION_REQUIRED, nothing posted", async () => {
    const f = wire();
    const r = await runCommand(changelogCommand, [DRAFT, "--note", "hello"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(posts(f)).toHaveLength(0);
  });

  test("a published uuid records on the linked DRAFT chain", async () => {
    const f = wire({ published: true });
    const r = await runCommand(changelogCommand, [PUB, "--note", "hello", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.chainId).toBe(DRAFT_ID);
    expect(d.chainUuid).toBe(DRAFT);
    expect(d.addedId).toBe(`note-${DRAFT_ID}-1`);
    expect(posts(f)).toEqual([`/rest/api/automation/chain/changelog/${DRAFT_ID}`]);
  });

  test("listing reads the chain of the uuid given, no write", async () => {
    const f = wire({ published: true });
    const r = await runCommand(changelogCommand, [PUB], { env: "t-dev" });
    expect((r.envelope?.data as any).chainId).toBe(PUB_ID);
    expect(posts(f)).toHaveLength(0);
  });
});

describe("findChangelogId", () => {
  test("newest USER_GENERATED entry with the comment, not older than the post", () => {
    const now = 1_000_000_000;
    const entries = [
      { id: "sys", comment: "x", changelogType: "EXPERTLY_SYSTEM", createdAt: now + 5 },
      { id: "old", comment: "x", changelogType: "USER_GENERATED", createdAt: now - 3_600_000 },
      { id: "new", comment: "x", changelogType: "USER_GENERATED", createdAt: now + 10 },
      { id: "other", comment: "y", changelogType: "USER_GENERATED", createdAt: now + 20 },
    ];
    expect(findChangelogId(entries, "x", now)).toBe("new");
    expect(findChangelogId(entries, "z", now)).toBeNull();
  });
});

describe("ad publish — validator gate + compiled cache", () => {
  const err = { rule: "AD-SCHEMA-001", severity: "error" as const, message: "bad", path: "outputs[0].key" };

  test("validation errors on the draft block the publish (nothing POSTed)", async () => {
    const f = wire();
    __setValidatorsForTests({ offline: () => ({ errors: [err], warnings: [], layersRun: ["L1"] }) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_VALIDATION_FAILED");
    expect(posts(f)).toEqual([]);
  });

  test("pre-existing errors (also in the published copy) block unless --allow-preexisting", async () => {
    let before: unknown;
    __setValidatorsForTests({
      offline: (input) => {
        before = input.before;
        return { errors: [], warnings: [{ ...err, severity: "warn", preexisting: true, originalSeverity: "error" }], layersRun: ["L1"] };
      },
    });
    const f = wire({ published: true });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_VALIDATION_FAILED");
    expect((before as any)?.uuid).toBe(PUB); // diff-aware against the current published copy
    expect(posts(f)).toEqual([]);
    const ok = await runCommand(publishCommand, [DRAFT, "--note", "n2", "--yes", "--allow-preexisting"], { env: "t-dev" });
    expect(ok.envelope?.ok).toBe(true);
    expect((ok.envelope!.data as any).validation.warnings).toHaveLength(1);
  });

  test("C7: a warning the published copy already has never blocks, even when its rule's catalogue severity is error", async () => {
    // The real validator on both sides: custom code language JAVA is CC1 reported as a warning (CC1 is an error rule).
    const java = () => {
      const b = draftV2();
      b.steps[0].properties.customCode.language = "JAVA";
      return b;
    };
    const f = wire({ published: true, draftV2: java, publishedV2: () => ({ ...java(), uuid: PUB, metadata: { ...draftV2().metadata, state: "PUBLISHED", referenceId: DRAFT } }) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const cc1 = (r.envelope!.data as any).validation.warnings.filter((w: any) => w.rule === "CC1");
    expect(cc1.map((w: any) => [w.preexisting, w.originalSeverity])).toEqual([[true, "warn"]]);
    expect(posts(f)[0]).toBe(`/rest/api/automation/chain/${DRAFT}/publish`);
  });

  test("a plain warning does not block; --no-validate skips the validator", async () => {
    __setValidatorsForTests({ offline: () => ({ errors: [], warnings: [{ ...err, rule: "AD-SCHEMA-003", severity: "warn" }], layersRun: ["L1"] }) });
    wire();
    expect((await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" })).envelope?.ok).toBe(true);
    let called = false;
    __setValidatorsForTests({ offline: () => ((called = true), { errors: [err], warnings: [], layersRun: [] }) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n3", "--yes", "--no-validate"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(called).toBe(false);
    expect((r.envelope!.data as any).validation.skipped).toBe(true);
  });

  test("after publishing, the compiled cache of draft + published is evicted on both routes", async () => {
    __setValidatorsForTests({ offline: () => ({ errors: [], warnings: [], layersRun: ["L1"] }) });
    const f = wire();
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const inv = f.requests.filter((q) => q.url.endsWith("cache/invalidate"));
    expect(inv.map((q) => q.url.replace("https://t-dev.test", ""))).toEqual([
      "/rest/api/cache/invalidate",
      "/rest/api/automations/cache/invalidate",
    ]);
    expect(inv[0]!.json()).toEqual({ uuids: [DRAFT, PUB], type: "AUTOMATION" });
    // publish happens before the invalidate
    const order = f.requests.map((q) => q.url);
    expect(order.findIndex((u) => u.endsWith("/publish"))).toBeLessThan(order.findIndex((u) => u.endsWith("cache/invalidate")));
    expect((r.envelope!.data as any).compiledCache.ok).toBe(true);
  });
});

describe("ad publish — what else the publish changes (A9, C5)", () => {
  const suite = (id: string, cases: Array<[string, string]>) => () => ({
    id,
    testCases: cases.map(([cid, name]) => ({ id: cid, name, description: "", inputs: [], assertions: [], active: true })),
  });

  test("A9: warns before about published-only cases and reports old/new suite and case ids, copied and removed", async () => {
    let suitePublished = false;
    const pubBefore = suite("suite-pub-1", [["p1", "m.a.1"], ["p2", "m.b.1"], ["p3", "m.only-published.1"]]);
    const pubAfter = suite("suite-pub-2", [["n1", "m.a.1"], ["n2", "m.b.1"]]);
    const f = wire({
      published: true,
      publish: () => ((suitePublished = true), { referenceId: PUB }),
      suites: {
        [DRAFT]: suite("suite-draft", [["d1", "m.a.1"], ["d2", "m.b.1"]]),
        [PUB]: () => (suitePublished ? pubAfter() : pubBefore()),
      },
    });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.testSuite).toEqual({
      previousSuiteId: "suite-pub-1",
      suiteId: "suite-pub-2",
      copied: [
        { name: "m.a.1", draftId: "d1", publishedId: "n1", previousId: "p1" },
        { name: "m.b.1", draftId: "d2", publishedId: "n2", previousId: "p2" },
      ],
      removed: [{ id: "p3", name: "m.only-published.1" }],
    });
    const warnings = ((r.envelope?.meta?.warnings ?? []) as string[]).join("\n");
    expect(warnings).toContain("published suite has 1 test case(s) the draft does not: m.only-published.1 (p3)");
    expect(warnings).toContain(`wi-impl ad test-case export ${PUB}`);
    expect(warnings).toContain("deleted 1 published test case(s)");
    // the warning comes BEFORE the publish: the suites are read first
    const order = f.requests.map((q) => q.url);
    expect(order.findIndex((u) => u.includes(`service-chain/${PUB}`))).toBeLessThan(order.findIndex((u) => u.endsWith("/publish")));
  });

  test("A9: first publish (no published copy) reports the copied cases; an unreadable suite never fails the publish", async () => {
    wire({ suites: { [DRAFT]: suite("suite-draft", [["d1", "m.a.1"]]), [PUB]: suite("suite-pub", [["n1", "m.a.1"]]) } });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect((r.envelope?.data as any).testSuite).toEqual({ previousSuiteId: null, suiteId: "suite-pub", copied: [{ name: "m.a.1", draftId: "d1", publishedId: "n1" }], removed: [] });
    wire({ suites: { [DRAFT]: () => respond({ status: 500, text: "boom" }) } });
    const bad = await runCommand(publishCommand, [DRAFT, "--note", "n2", "--yes"], { env: "t-dev" });
    expect(bad.envelope?.ok).toBe(true);
    expect((bad.envelope?.data as any).testSuite).toBeNull();
    expect((bad.envelope?.data as any).testSuiteError).toBeTruthy();
  });

  test("C5: an input the draft dropped is reported before the publish; the callers lookup never blocks", async () => {
    const withInputs = (keys: string[]) => {
      const b = draftV2();
      const proto = b.inputs[0] ?? { type: "TEXT", required: false, properties: [], encodingType: "NONE" };
      b.inputs = keys.map((key) => ({ ...proto, key, name: key }));
      return b;
    };
    wire({
      published: true,
      draftV2: () => withInputs(["epId"]),
      publishedV2: () => ({ ...withInputs(["epId", "items"]), uuid: PUB, metadata: { ...draftV2().metadata, state: "PUBLISHED", referenceId: DRAFT } }),
    });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.removedInputs.keys).toEqual(["items"]);
    expect(Array.isArray(d.removedInputs.callers)).toBe(true); // the lookup (index on this fake server or not) never blocks
    expect(((r.envelope?.meta?.warnings ?? []) as string[]).join("\n")).toContain("The draft drops input(s) items");
  });
});

describe("ad publish — freshness and real draft/published pairs", () => {
  const PAIRS = join(import.meta.dir, "../fixtures/draft-published");
  const pair = (f: string) => JSON.parse(readFileSync(join(PAIRS, f), "utf8"));

  test("a draft that changed between validation and the publish → AD_VERSION_CONFLICT, nothing published", async () => {
    let reads = 0;
    const f = wire({
      draftV2: () => {
        reads++;
        const b = draftV2();
        if (reads > 1) b.steps[0].description = "edited by someone else";
        return b;
      },
    });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("AD_VERSION_CONFLICT");
    expect((r.envelope?.error?.details as any).changedPaths).toEqual(["steps[0].description"]);
    expect(posts(f)).toEqual([]);
  });

  test("an unchanged draft publishes (changelog/testSuite churn is ignored)", async () => {
    let reads = 0;
    wire({
      draftV2: () => {
        reads++;
        return { ...draftV2(), changelogs: reads > 1 ? [{ note: "x" }] : [] };
      },
    });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  test("an unchanged real draft (different step ids from its published copy) publishes", async () => {
    const draft = pair("438b502717b979a6a8539691d673fc39.draft.v2.json");
    const published = pair("41f705aff6c768c033b4ad9840b69dde.published.v2.json");
    wire({ published: true, draftV2: () => structuredClone(draft), publishedV2: () => structuredClone(published) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).validation.warnings.every((w: any) => w.preexisting)).toBe(true);
  });

  test("pre-existing errors matched across different step ids block only until --allow-preexisting", async () => {
    const draft = pair("4ec6d9821f97ab6809e092ca0e414c84.draft.v2.json");
    const published = pair("438185931da72f5b89aaac3c6248a18e.published.v2.json");
    wire({ published: true, draftV2: () => structuredClone(draft), publishedV2: () => structuredClone(published) });
    const blocked = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes"], { env: "t-dev" });
    expect(blocked.envelope?.error?.code).toBe("AD_VALIDATION_FAILED");
    const d = blocked.envelope?.error?.details as any;
    expect(d.errors).toEqual([]);
    expect(d.blocking.map((f: any) => [f.rule, f.preexisting])).toEqual([
      ["AD-SPEL-001", true],
      ["AD-SPEL-001", true],
      ["AD-SPEL-001", true],
    ]);
    const ok = await runCommand(publishCommand, [DRAFT, "--note", "n", "--yes", "--allow-preexisting"], { env: "t-dev" });
    expect(ok.envelope?.ok).toBe(true);
  });
});

