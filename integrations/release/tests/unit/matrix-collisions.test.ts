// OTH-R20/R21/R24/R30: matrix item selection, collision detection, leak
// classification and the incomplete-input guard. Teamwork is faked over the
// wire (fakeFetch); AD tracing returns 503 so every item is a trace-error row.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Config, type CommandContext } from "@belzabar/core";
import { fakeFetch, respond, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { saveTeamworkSession } from "@belzabar/teamwork/lib/auth";
import matrix, { classifyLeak, type MatrixData } from "../../commands/matrix/index";
import { PROMOTION_DIR, RELEASES_DIR } from "../../lib/ledger";
import { resolveReleaseEnvs } from "../../lib/spec";

const dir = mkdtempSync(join(tmpdir(), "belz-release-matrix-"));
const ENVS = {
  "sems-dev": { url: "https://sems-dev.test" },
  "sems-stage": { url: "https://sems-stage.test" },
  "nsm-dev": { url: "https://nsm-dev.test" },
  "nsm-stage": { url: "https://nsm-stage.test" },
};

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

function ctx(): CommandContext {
  return {
    outputMode: "llm", env: Config.activeEnv, envExplicit: false, verbose: false,
    binaryName: "belz", commandName: "x", warn: () => {},
  };
}

function specFile(body: unknown): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

const U = (c: string) => c.repeat(32);
const adUrl = (uuid: string) => `https://sems-dev.test/automation-designer/Test-Parth/${uuid}`;

/** A ticket whose comments are the given bodies (oldest first). */
function ticketRoutes(id: number, bodies: string[]) {
  return [
    {
      method: "GET",
      url: new RegExp(`/tasks/${id}\\.json`),
      response: { task: { id, name: `Ticket ${id}`, description: "", subTaskIds: [] }, included: {} },
    },
    {
      method: "GET",
      url: new RegExp(`/tasks/${id}/comments\\.json`),
      response: {
        comments: bodies.map((body, i) => ({
          id: id * 10 + i, body, postedByUserId: 1, postedDateTime: `2026-09-0${i + 1}T00:00:00Z`,
        })),
        meta: { page: { hasMore: false } },
      },
    },
  ];
}

async function setup(routes: unknown[]) {
  cfg = withTempEnvConfig({
    envs: ENVS,
    activeEnv: "sems-dev",
    teamwork: { email: "me@x.test", password: "p", passwordEncoding: "plain" },
  });
  await saveTeamworkSession({ twAuth: "ok" });
  ff = fakeFetch([
    ...(routes as never[]),
    { url: /\.test\/rest\//, response: respond({ status: 503, json: {} }) },
  ]).install();
}

describe("OTH-R20: item selection", () => {
  test("an excluded ticket with ONE plain AD URL still collides (was invisible, 'Collisions: None')", async () => {
    const shared = U("a");
    await setup([
      ...ticketRoutes(100, [`Items to move\nAD Published Id: ${shared}, ${U("b")}`]),
      ...ticketRoutes(200, [`fixed it here: ${adUrl(shared)}`]),
    ]);
    const res = await matrix.execute({ specPath: specFile({ name: "r20", included: [100], excluded: [200] }) }, ctx());
    expect(res.ok).toBe(true);
    const d = res.data as MatrixData;
    const ex = d.tickets.find((t) => t.id === 200)!;
    expect(ex.ad).toEqual([shared]);
    expect(ex.adSource).toBe("all-refs");
    expect(d.collisions.map((c) => c.uuid)).toEqual([shared]);
    expect(d.collisions[0]!.leak).toBe("unknown"); // trace 503
    expect(d.collisionsComplete).toBe(true);
    // the linker's "No dev-note block" warning is passed on
    expect(d.warnings.some((w) => w.startsWith("Ticket #200: No dev-note block"))).toBe(true);
  });

  test("an included ticket with no dev-note block falls back to every AD reference", async () => {
    await setup([
      ...ticketRoutes(100, [`see ${adUrl(U("c"))}`]),
      ...ticketRoutes(200, [`see ${adUrl(U("c"))}`]),
    ]);
    const d = (await matrix.execute({ specPath: specFile({ name: "r20b", included: [100], excluded: [200] }) }, ctx())).data as MatrixData;
    expect(d.tickets.find((t) => t.id === 100)).toMatchObject({ ad: [U("c")], adSource: "all-refs" });
    expect(d.collisions).toHaveLength(1);
  });

  test("an included ticket with a dev-note block uses the latest block only", async () => {
    await setup([
      ...ticketRoutes(100, [`${adUrl(U("d"))} ${adUrl(U("e"))}`, `${adUrl(U("e"))} ${adUrl(U("f"))}`]),
      ...ticketRoutes(200, [`${adUrl(U("d"))}`]),
    ]);
    const d = (await matrix.execute({ specPath: specFile({ name: "r20c", included: [100], excluded: [200] }) }, ctx())).data as MatrixData;
    expect(d.tickets.find((t) => t.id === 100)).toMatchObject({ ad: [U("e"), U("f")], adSource: "dev-note" });
    expect(d.collisions).toHaveLength(0);
  });

  test("an excluded ticket contributes references from earlier blocks too", async () => {
    await setup([
      ...ticketRoutes(100, [`${adUrl(U("d"))} ${adUrl(U("e"))}`]),
      ...ticketRoutes(200, [`${adUrl(U("d"))} ${adUrl(U("9"))}`, `${adUrl(U("8"))} ${adUrl(U("7"))}`]),
    ]);
    const d = (await matrix.execute({ specPath: specFile({ name: "r20d", included: [100], excluded: [200] }) }, ctx())).data as MatrixData;
    expect(d.collisions.map((c) => c.uuid)).toEqual([U("d")]);
  });
});

describe("OTH-R21: a ticket that fails to link", () => {
  test("→ RELEASE_MATRIX_INCOMPLETE, collisionsComplete:false, no ledger record", async () => {
    await setup([
      ...ticketRoutes(100, [`${adUrl(U("a"))}`]),
      { method: "GET", url: /\/tasks\/200\.json/, response: respond({ status: 500, json: {} }) },
    ]);
    const res = await matrix.execute({ specPath: specFile({ name: "r21", included: [100], excluded: [200] }) }, ctx());
    if (res.ok) throw new Error("expected a failure");
    expect(res.error.code).toBe("RELEASE_MATRIX_INCOMPLETE");
    expect(res.error.message).toContain("#200");
    const d = res.data as MatrixData;
    expect(d.collisionsComplete).toBe(false);
    expect(d.collisions).toEqual([]);
    expect(existsSync(join(RELEASES_DIR, "r21.json"))).toBe(false);
  });
});

describe("OTH-R30: leak classification", () => {
  const cell = (env: string, status: string, spinePos = 0) => ({ env, status, spinePos, spineVersion: null });
  const cases: Array<[string, Parameters<typeof classifyLeak>[0], string]> = [
    ["stage at spine head", { envs: [cell("sems-stage", "latest", 3)] }, "leaked"],
    ["stage behind", { envs: [cell("sems-stage", "behind", 1)] }, "clean"],
    ["stage missing the method", { envs: [cell("sems-stage", "missing", -1)] }, "unknown"],
    ["stage diverged", { envs: [cell("sems-stage", "ahead-or-diverged", -1)] }, "unknown"],
    ["stage trace error", { envs: [cell("sems-stage", "error", -1)] }, "unknown"],
    ["stage not traced", { envs: [cell("sems-dev", "latest", 3)] }, "unknown"],
    ["whole trace failed", { envs: [cell("sems-stage", "latest", 3)], error: "boom" }, "unknown"],
  ];
  for (const [label, item, leak] of cases) {
    test(`${label} → ${leak}`, () => {
      expect(classifyLeak(item, "sems-stage").leak).toBe(leak as never);
    });
  }
});

describe("OTH-R24: spine and stage from different projects", () => {
  test("→ BAD_SPEC (the tracer would never reach the stage env)", () => {
    cfg = withTempEnvConfig({ envs: ENVS });
    const all = Config.getAllEnvs();
    let code = "";
    try {
      resolveReleaseEnvs({ spineEnv: "sems-dev", stageEnv: "nsm-stage" }, all["sems-dev"]!, all);
    } catch (e) {
      code = (e as { code: string }).code;
    }
    expect(code).toBe("BAD_SPEC");
    expect(resolveReleaseEnvs({ project: "sems" }, all["nsm-dev"]!, all).stageEnv).toBe("sems-stage");
  });
});
