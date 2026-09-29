// AD-25: `ad trace` defaults the spine to the active env and only visits the
// spine's project family (or --envs); a DRAFT uuid is traced via its
// published chain (F7: the published history is what history.get reads
// without includeDraft).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Config } from "@belzabar/core";
import { runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import traceCommand from "../../commands/trace/index";
import { adApi } from "../../lib/api/index";
import { traceEnvFamily } from "../../lib/trace";

const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
const PUB = "44bd316200cb2ff1fd5c82da374724e3";
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

function fake() {
  const listed: Array<[string, string]> = [];
  spies.push(
    spyOn(adApi, "fetchMethod").mockImplementation(async (uuid: string) =>
      (uuid === DRAFT
        ? { uuid: DRAFT, state: "DRAFT", referenceId: PUB, name: "m", category: { name: "C" } }
        : { uuid: PUB, state: "PUBLISHED", referenceId: DRAFT, name: "m", category: { name: "C" } }) as any,
    ),
    spyOn(adApi, "historyListAll").mockImplementation(async (uuid: string) => {
      listed.push([Config.activeEnv.name, uuid]);
      return [{ methodVersion: 1, methodVersionID: "v1", methodID: uuid, isPublished: true, isDeactivated: false, addedBy: 1, addedWhen: "2026-01-01" }];
    }),
    spyOn(adApi, "historyGet").mockImplementation(async () =>
      ({ methodVersion: 1, methodVersionID: "v1", methodID: PUB, isPublished: true, isDeactivated: false, addedBy: 1, addedWhen: "2026-01-01", jsonDefinition: { name: "m", inputs: [], services: [] } }) as any,
    ),
  );
  return listed;
}

const ENVS = { "sems-x": { url: "https://sx.test" }, "sems-y": { url: "https://sy.test" }, "ys-x": { url: "https://y.test" } };

describe("ad trace env scope (AD-25)", () => {
  test("traceEnvFamily: spine first, same project only", () => {
    using _cfg = withTempEnvConfig({ envs: ENVS });
    expect(traceEnvFamily("sems-x")).toEqual(["sems-x", "sems-y"]);
    expect(traceEnvFamily("nsm-dev")).toEqual(["nsm-dev", "nsm-qa", "nsm-uat"]);
  });

  test("default spine = active env; only its project is visited; draft uuid -> published chain", async () => {
    using _cfg = withTempEnvConfig({ envs: ENVS });
    const listed = fake();
    const r = await runCommand(traceCommand, [DRAFT], { env: "sems-x" });
    expect(r.envelope?.ok).toBe(true);
    const d = r.envelope?.data as any;
    expect(d.spineEnv).toBe("sems-x");
    expect(d.envs).toEqual(["sems-x", "sems-y"]);
    expect(d.uuid).toBe(PUB);
    expect(d.inputUuid).toBe(DRAFT);
    expect(new Set(listed.map(([env]) => env))).toEqual(new Set(["sems-x", "sems-y"]));
    expect(listed.every(([, uuid]) => uuid === PUB)).toBe(true);
    expect(d.environments.map((e: any) => e.status)).toEqual(["latest", "latest"]);
  });

  test("--envs picks envs explicitly; unknown env is refused", async () => {
    using _cfg = withTempEnvConfig({ envs: ENVS });
    fake();
    const r = await runCommand(traceCommand, [PUB, "--envs", "ys-x"], { env: "sems-x" });
    expect((r.envelope?.data as any).envs).toEqual(["sems-x", "ys-x"]);
    const bad = await runCommand(traceCommand, [PUB, "--envs", "nope"], { env: "sems-x" });
    expect(bad.envelope?.error?.code).toBe("UNKNOWN_ENV");
  });
});

// ADR-R14: published history versions are immutable; a re-run reads them from cache.
describe("trace caches published history bodies (ADR-R14)", () => {
  test("second run makes no historyGet calls; cache is per env + methodVersionID", async () => {
    using _cfg = withTempEnvConfig({ envs: ENVS });
    const vid = `r14-${Date.now()}`;
    spies.push(
      spyOn(adApi, "fetchMethod").mockResolvedValue({ uuid: PUB, state: "PUBLISHED", name: "m", category: { name: "C" } } as any),
      spyOn(adApi, "historyListAll").mockImplementation(async (uuid: string) => [
        { methodVersion: 1, methodVersionID: vid, methodID: uuid, isPublished: true, isDeactivated: false, addedBy: 1, addedWhen: "2026-01-01" },
      ]),
    );
    const get = spyOn(adApi, "historyGet").mockImplementation(async () =>
      ({ methodVersion: 1, methodVersionID: vid, methodID: PUB, isPublished: true, isDeactivated: false, addedBy: 1, addedWhen: "2026-01-01", jsonDefinition: { name: "m", inputs: [], services: [] } }) as any,
    );
    spies.push(get);
    const first = await runCommand(traceCommand, [PUB], { env: "sems-x" });
    expect(first.envelope?.ok).toBe(true);
    expect(get.mock.calls.length).toBe(2); // spine version on sems-x (the sems-x env row reuses it) + the sems-y head
    const second = await runCommand(traceCommand, [PUB], { env: "sems-x" });
    expect((second.envelope?.data as any).environments.map((e: any) => e.status)).toEqual(["latest", "latest"]);
    expect(get.mock.calls.length).toBe(2);
  });
});
