// `ad state`: sync is a content question, `versions` is in the
// data as the help promises, and each side is fetched once.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { CliError } from "@belzabar/core";
import { fakeFetch, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import stateCommand from "../../commands/state/index";

const FIX = join(import.meta.dir, "../fixtures/history");
const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
const PUB = "0000000000000000000000000000beef";
// State reads both sides on V2 (the sync fingerprint compares V2 bodies).
const draftBody = () => JSON.parse(readFileSync(join(FIX, "chain-v2-draft.json"), "utf8"));
const V2 = (u: string) => `GET /rest/api/automation/chain/v2/${u}?basicInfo=false`;
const withMeta = (b: any, meta: Record<string, unknown>) => ({ ...b, metadata: { ...b.metadata, ...meta } });

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

/** A published sibling of the real draft: same logic, independent version counter. */
function pair(opts: { draftCode?: string; draftScope?: string } = {}) {
  const draft = withMeta(draftBody(), { referenceId: PUB, version: { ...draftBody().metadata.version, name: "12" } });
  if (opts.draftCode) draft.steps[0].properties.customCode.inlineCode = opts.draftCode;
  if (opts.draftScope) draft.permissions = { ...(draft.permissions ?? {}), methodScope: opts.draftScope };
  const pub = withMeta({ ...draftBody(), uuid: PUB }, { state: "PUBLISHED", referenceId: DRAFT, version: { ...draftBody().metadata.version, uuid: PUB, name: "8" } });
  pub.steps = pub.steps.map((st: any, i: number) => ({ ...st, id: `4${String(i).padStart(31, "0")}` })); // published copies get new step ids
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  ff = fakeFetch({ [V2(DRAFT)]: draft, [V2(PUB)]: pub }).install();
  return ff;
}

describe("ad state", () => {
  test("draft v12 vs published v8 with identical logic -> inSync:true (not 'draft ahead')", async () => {
    pair();
    const r = await runCommand(stateCommand, [PUB], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(r.envelope?.ok).toBe(true);
    expect(d.versions).toEqual({ draft: 12, published: 8 });
    expect(d.inSync).toBe(true);
    expect(d.fingerprints.draft).toBe(d.fingerprints.published);
    expect(d.switchedFromPublished).toBe(true);
  });

  test("C24: each side's scope is reported, read fresh", async () => {
    pair({ draftScope: "INTERNAL_ALL_SERVICE" });
    const r = await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    expect((r.envelope?.data as any).scopes).toEqual({ draft: "INTERNAL_ALL_SERVICE", published: "UNRESTRICTED" });
  });

  test("different draft code -> inSync:false", async () => {
    pair({ draftCode: 'console.log("changed");' });
    const r = await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.inSync).toBe(false);
    expect(d.draftUuid).toBe(DRAFT);
    expect(d.publishedUuid).toBe(PUB);
  });

  test("one V2 GET per side", async () => {
    const f = pair();
    const v2Gets = () => f.requests.filter((q) => q.method === "GET" && q.url.includes("/chain/v2/"));
    await runCommand(stateCommand, [PUB], { env: "t-dev" });
    expect(v2Gets().map((q) => q.url.split("/").pop()!.split("?")[0]).sort()).toEqual([PUB, DRAFT].sort());
    f.requests.length = 0;
    await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    expect(v2Gets()).toHaveLength(2);
  });

  test("never-published draft -> inSync:null", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch({ [V2(DRAFT)]: draftBody() }).install();
    const r = await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.inSync).toBeNull();
    expect(d.versions).toEqual({ draft: 4, published: null });
    expect(d.publishedReadFailed).toBeUndefined();
  });

  // D18: a timed-out published read is not "never published".
  test("a published read that times out -> ok:false, publishedReadFailed, never a plain null", async () => {
    const draft = withMeta(draftBody(), { referenceId: PUB });
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    ff = fakeFetch({
      [V2(DRAFT)]: draft,
      [V2(PUB)]: () => {
        throw new CliError("Request timed out after 60s", { code: "HTTP_TIMEOUT" });
      },
    }).install();
    const r = await runCommand(stateCommand, [DRAFT], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d).toMatchObject({ ok: false, publishedUuid: PUB, publishedVersion: null, inSync: null, publishedReadFailed: true, publishedReadError: "HTTP_TIMEOUT" });
    expect(d.message).toContain("not \"never published\"");
  });

  // D32 / B133: when each side was last saved (the V1 chain's stamp; V2 has none).
  test("updatedOn per side, ISO UTC, from the V1 chain (createdOn when never updated)", async () => {
    cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
    const draft = withMeta(draftBody(), { referenceId: PUB });
    const pub = withMeta({ ...draftBody(), uuid: PUB }, { state: "PUBLISHED", referenceId: DRAFT });
    ff = fakeFetch({
      [V2(DRAFT)]: draft,
      [V2(PUB)]: pub,
      [`GET /rest/api/automation/chain/${DRAFT}`]: { uuid: DRAFT, updatedOn: Date.UTC(2026, 10, 10, 10, 0, 56, 688), createdOn: 1 },
      [`GET /rest/api/automation/chain/${PUB}`]: { uuid: PUB, createdOn: Date.UTC(2026, 0, 2) },
    }).install();
    const d = (await runCommand(stateCommand, [DRAFT], { env: "t-dev" })).envelope?.data as any;
    expect(d.updatedOn).toEqual({ draft: "2026-11-10T10:00:56.688Z", published: "2026-01-02T00:00:00.000Z" });
  });
});
