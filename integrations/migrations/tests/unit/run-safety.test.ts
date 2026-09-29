// `migrate run` refuses bad input before any build,
// and every failure after the build was triggered carries its reference.
// Jenkins and AD are fully faked; nothing leaves the process.
import { afterEach, describe, expect, test } from "bun:test";
import { fakeFetch, type FakeFetch, fixture, rejectionCode as code, respond, runCommand, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
import { parseMigrateRunArgs, resolveMigrationTargets } from "../../lib";
import runCmdModule from "../../commands/run/index";
import profilesCmdModule from "../../commands/profiles/index";

// The `migrate` namespace is not env-aware (targets come from the profile).
const runCmd = { ...runCmdModule, envAware: false };
const profilesCmd = { ...profilesCmdModule, envAware: false };

/** Profile segment → env mapping (config `jenkins.profileEnvs`); belz has no built-in one. */
const PROFILE_ENVS = { devacme: "acme-dev", qaacme: "acme-qa", stageacme: "acme-stage", qagm: "gm-qa", stagegm: "gm-stage", qabravo: "orb-qa", stgbravo: "orb-stage" };

let cfg: TempEnvConfig | null = null;
let ff: FakeFetch | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

const JENKINS = { baseUrl: "https://jk.test", user: "u", password: "p", passwordEncoding: "plain" as const, migrationJob: "A/b" };
const JOB = "https://jk.test/job/A/job/b";
const JOB_PARAMS = { method: "GET", url: /\/api\/json\?tree=property/, response: fixture(`${import.meta.dir}/../fixtures/real/job-parameters.json`) };
const UUID = "4d075e621c93206fb95d84795fc05e00";

describe("AD pre-flight", () => {
  function acmeDev() {
    cfg = withTempEnvConfig({ envs: { "acme-dev": { url: "https://acme-dev.test" } }, jenkins: { profileEnvs: PROFILE_ENVS } });
  }
  const resolve = (id: string) => resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: [id] });

  test("unknown uuid: 200 with an empty body → MIGRATE_TARGET_NOT_FOUND (real acme-dev shape)", async () => {
    acmeDev();
    ff = fakeFetch([{ url: /chain\//, response: respond({ status: 200, text: "" }) }]).install();
    expect(await code(resolve(UUID))).toBe("MIGRATE_TARGET_NOT_FOUND");
  });

  test("unknown uuid: 200 with `null` → MIGRATE_TARGET_NOT_FOUND (was UNHANDLED_EXCEPTION)", async () => {
    acmeDev();
    ff = fakeFetch([{ url: /chain\//, response: respond({ status: 200, text: "null", headers: { "content-type": "application/json" } }) }]).install();
    expect(await code(resolve(UUID))).toBe("MIGRATE_TARGET_NOT_FOUND");
  });

  test("all-digit or non-uuid ids are refused before any request", async () => {
    acmeDev();
    ff = fakeFetch([]).install();
    expect(await code(resolve("00000000000000000000000000000001"))).toBe("MIGRATE_TARGET_ID_INVALID");
    expect(await code(resolve("u1"))).toBe("MIGRATE_TARGET_ID_INVALID");
    expect(ff.requests).toHaveLength(0);
  });

  test("a method that comes back with another uuid → MIGRATE_TARGET_ID_MISMATCH", async () => {
    acmeDev();
    ff = fakeFetch([{ url: /chain\//, response: { uuid: "ffffffffffffffffffffffffffffffff", name: "Create activity" } }]).install();
    expect(await code(resolve(UUID))).toBe("MIGRATE_TARGET_ID_MISMATCH");
  });

  test("a body that stalls keeps HTTP_TIMEOUT (was swallowed into MIGRATE_TARGET_NOT_FOUND)", async () => {
    acmeDev();
    const enc = new TextEncoder();
    ff = fakeFetch([{
      url: /chain\//,
      response: () => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('{"uuid":')); } }), { status: 200, headers: { "content-type": "application/json" } }),
    }]).install();
    const prev = process.env.BELZ_HTTP_TIMEOUT_MS;
    process.env.BELZ_HTTP_TIMEOUT_MS = "30";
    try {
      let err: { code?: string; message?: string; details?: Record<string, unknown> } = {};
      try {
        await resolve(UUID);
      } catch (e) {
        err = e as typeof err;
      }
      expect(err.code).toBe("HTTP_TIMEOUT");
      expect(err.message).toContain("Retry when");
      expect(err.details?.preflightEnv).toBe("acme-dev");
    } finally {
      if (prev === undefined) delete process.env.BELZ_HTTP_TIMEOUT_MS;
      else process.env.BELZ_HTTP_TIMEOUT_MS = prev;
    }
  });

  test("a real method resolves with its name", async () => {
    acmeDev();
    ff = fakeFetch([{ url: /chain\//, response: { uuid: UUID, name: "belz.thing" } }]).install();
    const r = await resolve(UUID);
    expect(r?.targets[0]).toMatchObject({ resolvedId: UUID, name: "belz.thing" });
  });
});

describe("module and migration-id flags", () => {
  const base = ["--profile", "devacme_qaacme", "--ids", UUID];
  test("--module with --module-custom → MIGRATE_MODULE_CONFLICT", async () => {
    expect(await code(parseMigrateRunArgs([...base, "--module", "PD", "--module-custom", "X"]))).toBe("MIGRATE_MODULE_CONFLICT");
  });
  test("report/status modules need --migration-id", async () => {
    for (const m of ["AD_COMPARISON_REPORT", "PD_MIGRATION_STATUS"]) {
      expect(await code(parseMigrateRunArgs(["--profile", "devacme_qaacme", "--module", m]))).toBe("MIGRATE_MIGRATION_ID_REQUIRED");
    }
    const ok = await parseMigrateRunArgs(["--profile", "devacme_qaacme", "--module", "AD_COMPARISON_REPORT", "--migration-id", "m-1"]);
    expect(ok.migrationId).toBe("m-1");
  });
});

describe("--client vs profile", () => {
  test("a client that isn't the profile's group → MIGRATE_CLIENT_PROFILE_MISMATCH, nothing POSTed", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([JOB_PARAMS]).install();
    const r = await runCommand(runCmd, [
      "--profile", "devacme_qaacme", "--client", "DELTA", "--module", "PD", "--ids", "p1", "--no-follow", "--yes",
    ]);
    expect(r.envelope?.error?.code).toBe("MIGRATE_CLIENT_PROFILE_MISMATCH");
    expect((r.envelope?.error?.details as { expected: string }).expected).toBe("ACME");
    expect(ff.requests.some((q) => q.method === "POST")).toBe(false);
  });
  test("client names come from the Jenkins dividers (case-insensitive); unknown → MIGRATE_INVALID_CLIENT listing them", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([JOB_PARAMS, JOB_PARAMS]).install();
    const okRun = await runCommand(profilesCmd, ["--client", "acme", "--refresh"]);
    expect((okRun.envelope?.data as { groups: Array<{ client: string }> }).groups.map((g) => g.client)).toEqual(["ACME"]);
    const bad = await runCommand(profilesCmd, ["--client", "nope", "--refresh"]);
    expect(bad.envelope?.error?.code).toBe("MIGRATE_INVALID_CLIENT");
    expect((bad.envelope?.error?.details as { known: string[] }).known).toContain("ACME");
  });
});

describe("failures after the trigger carry the build reference", () => {
  const argv = ["--profile", "devacme_qaacme", "--client", "ACME", "--module", "PD", "--ids", "p1", "--no-follow", "--yes"];
  const trigger = [
    JOB_PARAMS,
    { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) },
    { method: "POST", url: `${JOB}/buildWithParameters`, response: respond({ status: 201, headers: { location: "https://jk.test/queue/item/7/" } }) },
  ];

  test("getBuild transport error → same code, details.buildNumber/buildUrl, do-not-rerun hint", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([
      ...trigger,
      { method: "GET", url: "https://jk.test/queue/item/7/api/json", response: { id: 7, executable: { number: 42, url: `${JOB}/42/` } } },
      { method: "GET", url: `${JOB}/42/api/json`, response: respond({ status: 502, text: "bad gateway" }) },
    ]).install();
    const r = await runCommand(runCmd, argv);
    const err = r.envelope?.error;
    expect(err?.code).toStartWith("MIGRATE_JENKINS");
    expect(err?.message).toContain("do NOT re-run");
    expect(err?.message).toContain("belz migrate status 42");
    expect(err?.details).toMatchObject({
      buildTriggered: true, buildNumber: 42, buildUrl: `${JOB}/42/`, queueUrl: "https://jk.test/queue/item/7/",
    });
  });

  test("queue cancelled before a build number → details.queueUrl", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([
      ...trigger,
      { method: "GET", url: "https://jk.test/queue/item/7/api/json", response: { id: 7, cancelled: true, why: "x" } },
    ]).install();
    const r = await runCommand(runCmd, argv);
    expect(r.envelope?.error?.code).toBe("MIGRATE_JENKINS_QUEUE_CANCELLED");
    expect(r.envelope?.error?.details).toMatchObject({ buildTriggered: true, queueUrl: "https://jk.test/queue/item/7/" });
  });

  test("2xx trigger without a queue Location still says a build was triggered", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([
      JOB_PARAMS,
      { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) },
      { method: "POST", url: `${JOB}/buildWithParameters`, response: respond({ status: 201 }) },
    ]).install();
    const r = await runCommand(runCmd, argv);
    expect(r.envelope?.error?.code).toBe("MIGRATE_JENKINS_NO_QUEUE_LOCATION");
    expect(r.envelope?.error?.details).toMatchObject({ buildTriggered: true, jobUrl: `${JOB}/` });
  });
});
