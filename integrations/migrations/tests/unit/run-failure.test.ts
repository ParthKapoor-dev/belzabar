// `migrate run` when an entity fails or the migration goes to background mode.
// Consoles are sanitized captures: build 2446 (PD, SUCCESS, report row FAILED
// with no reason), 2447 (its PD_MIGRATION_STATUS build, `FAILED ITEM` line with
// the reason), 2789 (AD, "Migration running in background (HTTP 206)", FAILURE).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fakeFetch, type FakeFetch, fixture, respond, runCommand, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
import { CACHE_REPEAT_DELAY_MS } from "@belzabar/core/platform";
import { failedEntitiesOf, landingTiming, parseJenkinsConsole, targetCacheTiming } from "../../lib";
import runCmdModule from "../../commands/run/index";

const runCmd = { ...runCmdModule, envAware: false };
const FIX = `${import.meta.dir}/../fixtures/real`;
const PD_FAILED = readFileSync(`${FIX}/build-2446-console-0.txt`, "utf8");
const PD_STATUS = readFileSync(`${FIX}/build-2447-console-0.txt`, "utf8");
const AD_BACKGROUND = readFileSync(`${FIX}/build-2789-console-0.txt`, "utf8");
const PAGE = "4550da74662d96d11bfe83cd19de21ad";
const MIGRATION_ID = "2e4dd044-c834-4828-a836-34fdbc80ed4a";
const A = "4bbd77bdfb3ae3d4aadda969b4ec9cf8";
const B = "471e63272ce0f1b69351955d0ea3c73f";

describe("console parsing", () => {
  test("the status build's FAILED ITEM line carries the reason", () => {
    const parsed = parseJenkinsConsole(PD_STATUS);
    expect(parsed.failedItems).toHaveLength(1);
    expect(parsed.failedItems[0]).toMatchObject({ id: PAGE, kind: "COMPONENT", status: "FAILED" });
    expect(parsed.failedItems[0]!.reason).toContain("Failed to assign phrases");
  });

  test("a SUCCESS PD build whose report row FAILED: a failed entity without a reason", () => {
    const parsed = parseJenkinsConsole(PD_FAILED);
    expect(parsed.reportSummary?.failedCount).toBe(1);
    expect(parsed.failedItems).toEqual([]);
    expect(failedEntitiesOf(parsed)).toEqual([{ id: PAGE, name: "check_permission", status: "FAILED" }]);
  });

  test("a FAILED ITEM line and its report row merge into one entity", () => {
    const parsed = parseJenkinsConsole(`${PD_FAILED}\nx => PD :: FAILED ITEM: ${PAGE} (PAGE, FAILED) :: Error creating page: missing deps\n`);
    expect(failedEntitiesOf(parsed)).toEqual([
      { id: PAGE, kind: "PAGE", status: "FAILED", reason: "Error creating page: missing deps", reasonFrom: "console", name: "check_permission" },
    ]);
  });

  test("background mode is recognised", () => {
    expect(parseJenkinsConsole(AD_BACKGROUND).background).toBe(true);
    expect(parseJenkinsConsole(PD_FAILED).background).toBe(false);
  });
});

describe("migrate run over faked builds", () => {
  const JENKINS = { baseUrl: "https://jk.test", user: "u", password: "p", passwordEncoding: "plain" as const, migrationJob: "A/b" };
  const JOB = "https://jk.test/job/A/job/b";
  let cfg: TempEnvConfig | null = null;
  let ff: FakeFetch | null = null;
  afterEach(() => {
    targetCacheTiming.delayMs = CACHE_REPEAT_DELAY_MS;
    landingTiming.intervalMs = 15_000;
    landingTiming.timeoutMs = 5 * 60_000;
    ff?.restore();
    ff = null;
    cfg?.restore();
    cfg = null;
  });

  /** Jenkins routes for build `n` (queue item `n`) with `consoleText` and `result`. */
  function buildRoutes(n: number, consoleText: string, result: string) {
    return [
      { method: "GET", url: `https://jk.test/queue/item/${n}/api/json`, response: { id: n, executable: { number: n, url: `${JOB}/${n}/` } } },
      { method: "GET", url: `${JOB}/${n}/logText/progressiveText?start=0`, response: respond({ text: consoleText, headers: { "X-Text-Size": String(consoleText.length) } }) },
      { method: "GET", url: new RegExp(`/${n}/logText/progressiveText\\?start=[1-9]`), response: respond({ text: "", headers: { "X-Text-Size": String(consoleText.length) } }) },
      { method: "GET", url: `${JOB}/${n}/api/json`, response: { number: n, building: false, result, duration: 1000, url: `${JOB}/${n}/` } },
    ];
  }

  function jenkinsBase(queueItems: number[]) {
    let next = 0;
    return [
      { method: "GET", url: /\/api\/json\?tree=property/, response: fixture(`${FIX}/job-parameters.json`) },
      { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) },
      {
        method: "POST",
        url: `${JOB}/buildWithParameters`,
        response: () => new Response("", { status: 201, headers: { location: `https://jk.test/queue/item/${queueItems[next++]}/` } }),
      },
    ];
  }

  test("H1: a FAILED entity fails the run, with the reason read through a status build", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: { devacme: "acme-dev", qaacme: "acme-qa" } } });
    ff = fakeFetch([...jenkinsBase([42, 43]), ...buildRoutes(42, PD_FAILED, "SUCCESS"), ...buildRoutes(43, PD_STATUS, "SUCCESS")]).install();
    const r = await runCommand(runCmd, ["--profile", "devacme_qaacme", "--client", "ACME", "--module", "PD", "--ids", PAGE, "--yes", "--quiet"]);
    expect(r.envelope?.ok).toBe(false);
    const err = r.envelope?.error;
    expect(err?.code).toBe("MIGRATE_ENTITY_FAILED");
    expect(err?.message).toContain(`check_permission ${PAGE} (COMPONENT): Error creating component: Failed to assign phrases`);
    expect(err?.message).not.toContain("do NOT re-run");
    expect(err?.details).toMatchObject({
      buildNumber: 42,
      failedEntities: [{ id: PAGE, reasonFrom: "status-build" }],
      statusBuild: { module: "PD_MIGRATION_STATUS", buildNumber: 43, result: "SUCCESS" },
    });
    const posts = ff.requests.filter((q) => q.method === "POST").map((q) => new URLSearchParams(q.body ?? ""));
    expect(posts).toHaveLength(2);
    expect(posts[1]!.get("MIGRATE_TYPE")).toBe("PD_MIGRATION_STATUS");
    expect(posts[1]!.get("MIGRATION_ID")).toBe(MIGRATION_ID);
    expect(posts[1]!.get("IDS")).toBe(PAGE);
  });

  function adEnvs() {
    return {
      envs: { "acme-dev": { url: "https://acme-dev.test" }, "acme-qa": { url: "https://acme-qa.test" } },
      jenkins: { ...JENKINS, profileEnvs: { devacme: "acme-dev", qaacme: "acme-qa" } },
    };
  }
  const chain = (uuid: string, version: number) => ({ uuid, name: `m.${uuid.slice(0, 4)}`, version });

  test("H8: background mode is not FAILED: the target is polled, landed ids reported and cleared", async () => {
    targetCacheTiming.delayMs = 0;
    landingTiming.intervalMs = 0;
    landingTiming.timeoutMs = 50;
    cfg = withTempEnvConfig(adEnvs());
    ff = fakeFetch([
      ...jenkinsBase([42]),
      ...buildRoutes(42, AD_BACKGROUND, "FAILURE"),
      { method: "GET", url: `https://acme-dev.test/rest/api/automation/chain/${A}`, response: chain(A, 3) },
      { method: "GET", url: `https://acme-dev.test/rest/api/automation/chain/${B}`, response: chain(B, 5) },
      { method: "GET", url: `https://acme-qa.test/rest/api/automation/chain/${A}`, response: chain(A, 3) },
      { method: "GET", url: `https://acme-qa.test/rest/api/automation/chain/${B}`, response: chain(B, 4) },
      { method: "POST", url: /acme-qa\.test\/rest\/api\/(automations\/)?cache\/invalidate/, response: respond({ status: 200, text: "" }) },
    ]).install();
    const r = await runCommand(runCmd, ["--profile", "devacme_qaacme", "--client", "ACME", "--module", "AD_Method", "--ids", `${A},${B}`, "--yes", "--quiet"]);
    expect(r.envelope?.ok).toBe(true);
    const data = r.envelope?.data as any;
    expect(data.result).toBe("FAILURE");
    expect(data.buildUrl).toBe(`${JOB}/42/`);
    expect(data.outcome).toBe("PARTIAL");
    expect(data.background).toMatchObject({ sourceEnv: "acme-dev", targetEnv: "acme-qa", landed: [A], notLanded: [B] });
    expect(data.background.rows[1]).toMatchObject({ id: B, sourceVersion: 5, targetVersion: 4, landed: false });
    expect(data.cacheInvalidated).toEqual({ env: "acme-qa", ids: [A] });
    const clear = ff.requests.find((q) => q.method === "POST" && q.url.includes("cache/invalidate"))!;
    expect(clear.json()).toEqual({ uuids: [A], type: "AUTOMATION" });
    const warnings = (r.envelope?.meta?.warnings ?? []) as string[];
    expect(warnings.some((w) => w.includes(`${B}: not on acme-qa`) && w.includes("source version 5, target 4"))).toBe(true);
  });

  test("H8: background mode with unknown envs is outcome BACKGROUND, not MIGRATE_RUN_FAILED", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: {} } });
    ff = fakeFetch([...jenkinsBase([42, 42]), ...buildRoutes(42, AD_BACKGROUND, "FAILURE")]).install();
    const r = await runCommand(runCmd, ["--profile", "devacme_qaacme", "--client", "ACME", "--module", "AD_Method", "--ids", A, "--yes", "--quiet"]);
    expect(r.envelope?.ok).toBe(true);
    const data = r.envelope?.data as any;
    expect(data.outcome).toBe("BACKGROUND");
    expect(data.background.skipped).toContain("unknown");
    const strict = await runCommand(runCmd, ["--profile", "devacme_qaacme", "--client", "ACME", "--module", "AD_Method", "--ids", A, "--yes", "--quiet", "--strict"]);
    expect(strict.envelope?.error?.code).toBe("MIGRATE_NOTHING_MIGRATED");
  });
});
