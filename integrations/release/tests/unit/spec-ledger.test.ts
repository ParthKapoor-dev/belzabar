// RL-1..4: spec validated up front (zod), spine/stage envs derived from the
// project, freeze fails when no item has stage data, atomic ledger with
// LEDGER_CORRUPT / collisions / --force.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Config, type CommandContext } from "@belzabar/core";
import { fakeFetch, fixture, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import matrix, { type MatrixData } from "../../commands/matrix/index";
import freeze from "../../commands/freeze/index";
import {
  PROMOTION_DIR, RELEASES_DIR, SNAPSHOTS_DIR, loadRelease, releaseSlug, saveProdSnapshot, saveRelease, type ProdSnapshot,
} from "../../lib/ledger";
import { resolveReleaseEnvs, validateReleaseSpec } from "../../lib/spec";
import { saveTeamworkSession } from "@belzabar/teamwork/lib/auth";

const FIX = join(import.meta.dir, "../../../teamwork/tests/fixtures/real");
const dir = mkdtempSync(join(tmpdir(), "belz-release-spec-"));

let cfg: TempEnvConfig | null = null;
let ff: FakeFetch | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  rmSync(PROMOTION_DIR, { recursive: true, force: true });
  rmSync(join(PROMOTION_DIR, "..", "sessions", "teamwork.json"), { force: true });
});

function ctx(): CommandContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    outputMode: "llm", env: Config.activeEnv, envExplicit: false, verbose: false,
    binaryName: "belz", commandName: "x", warn: (m: string) => warnings.push(m), warnings,
  };
}

function specFile(body: unknown): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

async function err(fn: () => unknown): Promise<any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

const ENVS = {
  "nsm-dev": { url: "https://nsm-dev.test" },
  "nsm-stage": { url: "https://nsm-stage.test" },
  "sems-dev": { url: "https://sems-dev.test" },
  "sems-stage": { url: "https://sems-stage.test" },
  "sems-qa": { url: "https://sems-qa.test" },
  "ys-qa": { url: "https://ys-qa.test" },
};

describe("RL-1: spec validated with zod, before any network", () => {
  const bad: Array<[string, unknown, string]> = [
    ["null spec", null, "(root)"],
    ["numeric name", { name: 123, included: [1] }, "name"],
    ["punctuation-only name", { name: "!!!", included: [1] }, "name: must contain a letter or digit"],
    ["missing included", { name: "r" }, "included"],
    ["empty included", { name: "r", included: [] }, "included: must list at least one ticket"],
    ["ticket of wrong type", { name: "r", included: [{ id: 1 }] }, "included.0"],
    ["typo'd key", { name: "r", included: [1], stageenv: "sems-stage" }, "unknown key(s) 'stageenv'"],
  ];
  for (const [label, body, fragment] of bad) {
    test(`${label} → BAD_SPEC (${fragment})`, async () => {
      cfg = withTempEnvConfig({ envs: ENVS });
      ff = fakeFetch([]).install();
      const e = await err(() => matrix.execute({ specPath: specFile(body) }, ctx()));
      expect(e.code).toBe("BAD_SPEC");
      expect(e.message).toContain(fragment);
      expect(ff.requests).toHaveLength(0);
    });
  }

  test("malformed JSON → BAD_SPEC; missing file → SPEC_NOT_FOUND", async () => {
    expect((await err(() => matrix.execute({ specPath: specFile("{nope") }, ctx()))).code).toBe("BAD_SPEC");
    expect((await err(() => matrix.execute({ specPath: join(dir, "absent.json") }, ctx()))).code).toBe("SPEC_NOT_FOUND");
  });

  test("excluded defaults to []", () => {
    expect(validateReleaseSpec({ name: "r", included: [1] }).excluded).toEqual([]);
  });
});

describe("RL-2: spine/stage envs derived from the project", () => {
  function envs() {
    cfg = withTempEnvConfig({ envs: ENVS });
    return Config.getAllEnvs();
  }

  test("active SEMS env → sems-dev / sems-stage (was nsm-dev / nsm-stage)", () => {
    const all = envs();
    expect(resolveReleaseEnvs({}, all["sems-qa"]!, all)).toEqual({ project: "SEMS", spineEnv: "sems-dev", stageEnv: "sems-stage" });
  });

  test("active NSM env keeps the old defaults", () => {
    const all = envs();
    expect(resolveReleaseEnvs({}, all["nsm-dev"]!, all)).toEqual({ project: "NSM", spineEnv: "nsm-dev", stageEnv: "nsm-stage" });
  });

  test("spec.project wins over the active env", () => {
    const all = envs();
    expect(resolveReleaseEnvs({ project: "sems" }, all["nsm-dev"]!, all)).toMatchObject({ spineEnv: "sems-dev", stageEnv: "sems-stage" });
  });

  test("an explicit stageEnv sets the project for the missing spineEnv", () => {
    const all = envs();
    expect(resolveReleaseEnvs({ stageEnv: "sems-stage" }, all["nsm-dev"]!, all)).toMatchObject({ project: "SEMS", spineEnv: "sems-dev" });
  });

  test("underivable or unknown envs → BAD_SPEC", async () => {
    const all = envs();
    expect((await err(() => resolveReleaseEnvs({}, all["ys-qa"]!, all))).message).toContain("no configured '*-dev' env for project YS");
    expect((await err(() => resolveReleaseEnvs({ spineEnv: "nope-dev" }, all["nsm-dev"]!, all))).code).toBe("BAD_SPEC");
    expect((await err(() => resolveReleaseEnvs({ project: "ZZ" }, all["nsm-dev"]!, all))).code).toBe("BAD_SPEC");
  });
});

describe("matrix end to end (real Teamwork fixture, faked transport)", () => {
  test("derives envs from the active env, writes the ledger atomically, refuses a slug collision", async () => {
    cfg = withTempEnvConfig({
      envs: ENVS,
      activeEnv: "sems-qa",
      teamwork: { baseUrl: "https://tw.example.test", email: "me@x.test", password: "p", passwordEncoding: "plain" },
    });
    await saveTeamworkSession({ twAuth: "ok" });
    ff = fakeFetch([
      { method: "GET", url: /\/tasks\/25807610\.json/, response: fixture(join(FIX, "task-25807610.json")) },
      { method: "GET", url: /\/tasks\/25807610\/comments\.json/, response: fixture(join(FIX, "task-25807610-comments-p1.json")) },
      { method: "GET", url: /\/tasks\/1\.json/, response: respond({ status: 404, json: {} }) },
      // AD tracing of any extracted item: history is "unavailable" → trace error rows, never real network.
      { url: /\.test\/rest\//, response: respond({ status: 503, json: {} }) },
    ]).install();

    const c = ctx();
    const res = await matrix.execute({ specPath: specFile({ name: "Sep 28", included: [25807610], excluded: [1] }) }, c);
    const d = res.data as MatrixData;
    expect(d.project).toBe("SEMS");
    expect(d.spineEnv).toBe("sems-dev");
    expect(d.stageEnv).toBe("sems-stage");
    expect(d.tickets.find((t) => t.id === 25807610)!.error).toBeUndefined();
    expect(d.tickets.find((t) => t.id === 1)!.error).toContain("not found");
    // OTH-R21: an unlinked ticket makes the audit incomplete — failed, nothing saved.
    if (res.ok) throw new Error("expected a failure");
    expect(res.error.code).toBe("RELEASE_MATRIX_INCOMPLETE");
    expect(existsSync(join(RELEASES_DIR, "sep-28.json"))).toBe(false);

    const good = await matrix.execute({ specPath: specFile({ name: "Sep 28", included: [25807610] }) }, ctx());
    expect(good.ok).toBe(true);
    const path = String(good.meta!.ledgerPath);
    expect(path).toBe(join(RELEASES_DIR, "sep-28.json"));
    expect(JSON.parse(readFileSync(path, "utf8")).name).toBe("Sep 28");
    expect(readdirSync(RELEASES_DIR).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const before = ff.requests.length;
    const e = await err(() => matrix.execute({ specPath: specFile({ name: "sep 28", included: [25807610] }) }, ctx()));
    expect(e.code).toBe("LEDGER_NAME_COLLISION");
    expect(ff.requests.length).toBe(before); // refused before any request
  });
});

function savedRelease(items: unknown[], stageEnv = "sems-stage") {
  return { name: "rel", stageEnv, spineEnv: "sems-dev", items };
}
const cell = (env: string, status: string, spinePos: number, spineVersion: number | null) => ({ env, status, spinePos, spineVersion });

describe("RL-3: freeze and missing stage data", () => {
  test("every item missing stage data → FREEZE_NO_STAGE_DATA, nothing written", async () => {
    saveRelease("rel", savedRelease([
      { uuid: "u1", name: "m1", envs: [cell("sems-dev", "latest", 3, 7)] },
      { uuid: "u2", name: "m2", envs: [cell("sems-stage", "error", -1, null)] },
    ]));
    const e = await err(() => freeze.execute({ name: "rel", force: false }, ctx()));
    expect(e.code).toBe("FREEZE_NO_STAGE_DATA");
    expect(existsSync(SNAPSHOTS_DIR)).toBe(false);
  });

  test("no items → FREEZE_NO_STAGE_DATA", async () => {
    saveRelease("rel", savedRelease([]));
    expect((await err(() => freeze.execute({ name: "rel", force: false }, ctx()))).code).toBe("FREEZE_NO_STAGE_DATA");
  });

  test("partial miss → recorded as unknown + warning; 'missing' stays a real 'not on stage'", async () => {
    saveRelease("rel", savedRelease([
      { uuid: "u1", name: "m1", envs: [cell("sems-stage", "behind", 2, 5)] },
      { uuid: "u2", name: "m2", envs: [cell("sems-stage", "missing", -1, null)] },
      { uuid: "u3", name: "m3", envs: [] },
    ]));
    const c = ctx();
    const res = await freeze.execute({ name: "rel", force: false }, c);
    const s = (res as { data: ProdSnapshot }).data;
    expect(s.items.map((i) => i.stageStatus)).toEqual(["behind", "missing", "unknown"]);
    expect(s.items[0]).toMatchObject({ spinePos: 2, spineVersion: 5 });
    expect(s.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain("m3 (u3): no sems-stage data");
  });
});

describe("RL-4: ledger safety", () => {
  test("corrupt JSON and wrong shape → LEDGER_CORRUPT (was UNHANDLED)", async () => {
    mkdirSync(RELEASES_DIR, { recursive: true });
    writeFileSync(join(RELEASES_DIR, "rel.json"), "{truncated");
    let e = await err(() => freeze.execute({ name: "rel", force: false }, ctx()));
    expect(e.code).toBe("LEDGER_CORRUPT");
    expect(e.message).toContain("not valid JSON");
    writeFileSync(join(RELEASES_DIR, "rel.json"), JSON.stringify({ name: "rel", items: "x" }));
    e = await err(() => loadRelease("rel"));
    expect(e.code).toBe("LEDGER_CORRUPT");
  });

  test("a name with no letters/digits → INVALID_RELEASE_NAME", async () => {
    expect((await err(() => freeze.execute({ name: "!!!", force: false }, ctx()))).code).toBe("INVALID_RELEASE_NAME");
    expect(releaseSlug("May 12 / Hotfix")).toBe("may-12-hotfix");
  });

  test("re-freezing needs --force; --force replaces atomically", async () => {
    saveRelease("rel", savedRelease([{ uuid: "u1", name: "m1", envs: [cell("sems-stage", "latest", 4, 9)] }]));
    await freeze.execute({ name: "rel", force: false }, ctx());
    const e = await err(() => freeze.execute({ name: "rel", force: false }, ctx()));
    expect(e.code).toBe("SNAPSHOT_EXISTS");
    const res = await freeze.execute({ name: "rel", force: true }, ctx());
    expect((res as { data: ProdSnapshot }).data.items[0]!.spinePos).toBe(4);
    expect(readdirSync(SNAPSHOTS_DIR)).toEqual(["rel.json"]);
  });

  test("saveProdSnapshot refuses to overwrite by default", async () => {
    const snap: ProdSnapshot = { release: "x", frozenAt: "t", capturedFrom: "s", items: [], warnings: [] };
    saveProdSnapshot(snap);
    expect((await err(() => saveProdSnapshot(snap))).code).toBe("SNAPSHOT_EXISTS");
  });
});
