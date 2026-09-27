// `ad publish` + `ad changelog --note`.
// AD-19: publish first, then the note (retried); a failed publish leaves no
// note; the note id is found from the list (the POST answers {"success":true},
// no id — live sems-dev). F39: an unknown uuid is a clean METHOD_NOT_FOUND.
// AD-32/33: `changelog --note` confirms and records on the draft chain.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  fakeFetch,
  respond,
  runCommand,
  withTempEnvConfig,
  type FakeFetch,
  type RecordedRequest,
  type TempEnvConfig,
} from "@belzabar/core/testing";
import publishCommand, { __setNoteRetryDelayForTests, NOTE_ATTEMPTS } from "../../commands/publish/index";
import changelogCommand from "../../commands/changelog/index";
import { findChangelogId } from "../../lib/api/changelog";

const FIX = join(import.meta.dir, "../fixtures/history");
const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
const PUB = "0000000000000000000000000000beef";
const DRAFT_ID = 20136;
const PUB_ID = 20999;
const draftBody = () => JSON.parse(readFileSync(join(FIX, "chain-v1-draft.json"), "utf8"));

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
const spies: Array<{ mockRestore(): void }> = [];
beforeAll(() => __setNoteRetryDelayForTests(0));
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  while (spies.length) spies.pop()!.mockRestore();
});

interface Opts {
  publish?: (req: RecordedRequest) => unknown;
  changelogPost?: (req: RecordedRequest) => unknown;
  published?: boolean; // draft already linked to PUB
}

function wire(opts: Opts = {}) {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
  const notes: any[] = [];
  let published = !!opts.published;
  ff = fakeFetch([
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
        if (opts.changelogPost) return opts.changelogPost(req);
        const b = req.json();
        notes.push({ id: `note-${notes.length + 1}`, comment: b.comment, changelogType: b.changelogType, createdAt: b.createdAt });
        return { success: true };
      },
    },
    { method: "GET", url: /\/chain\/changelog\/\d+$/, response: () => notes },
  ]).install();
  return ff;
}

const posts = (f: FakeFetch) => f.requests.filter((r) => r.method === "POST").map((r) => r.url.replace("https://t-dev.test", ""));

describe("ad publish (AD-19)", () => {
  test("publishes first, then records the note; reports noteRecorded + the note id from the list", async () => {
    const f = wire();
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect(posts(f)).toEqual([`/rest/api/automation/chain/${DRAFT}/publish`, `/rest/api/automation/chain/changelog/${DRAFT_ID}`]);
    const d = r.envelope?.data as any;
    expect(d.noteRecorded).toBe(true);
    expect(d.changelogId).toBe("note-1");
    expect(d.noteChainId).toBe(DRAFT_ID);
    expect(d.publishedUuid).toBe(PUB);
    expect(d.inSync).toBe(true); // same logic on both sides
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

  test("{success:false} from the changelog POST is a failure, not a recorded note", async () => {
    wire({ changelogPost: () => ({ success: false }) });
    const r = await runCommand(publishCommand, [DRAFT, "--note", "ship it", "--yes"], { env: "t-dev" });
    expect((r.envelope?.data as any).noteRecorded).toBe(false);
  });

  test("F39: unknown uuid -> METHOD_NOT_FOUND before any write", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ "GET /rest/api/automation/chain/*": respond({ status: 200, text: "" }) }).install();
    const r = await runCommand(publishCommand, ["00000000000000000000000000000000", "--note", "x", "--yes"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("METHOD_NOT_FOUND");
    expect(ff.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });
});

describe("ad changelog --note (AD-32/33)", () => {
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
    expect(d.addedId).toBe("note-1");
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
