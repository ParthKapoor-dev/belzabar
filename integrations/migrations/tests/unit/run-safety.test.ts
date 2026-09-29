// OTH-R22/R23/R25/R26/R27: `migrate run` refuses bad input before any build,
// and every failure after the build was triggered carries its reference.
// Jenkins and AD are fully faked; nothing leaves the process.
import { afterEach, describe, expect, test } from "bun:test";
import { fakeFetch, fixture, respond, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { parseMigrateRunArgs, resolveMigrationTargets } from "../../lib";
import runCmd from "../../commands/run/index";

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

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "(no error)";
}

describe("OTH-R22/R27: AD pre-flight", () => {
  function semsDev() {
    cfg = withTempEnvConfig({ envs: { "sems-dev": { url: "https://sems-dev.test" } } });
  }
  const resolve = (id: string) => resolveMigrationTargets({ profile: "devsems_qasems", migrateType: "AD_Method", ids: [id] });

  test("unknown uuid: 200 with an empty body → MIGRATE_TARGET_NOT_FOUND (real sems-dev shape)", async () => {
    semsDev();
    ff = fakeFetch([{ url: /chain\//, response: respond({ status: 200, text: "" }) }]).install();
    expect(await code(resolve(UUID))).toBe("MIGRATE_TARGET_NOT_FOUND");
  });

  test("unknown uuid: 200 with `null` → MIGRATE_TARGET_NOT_FOUND (was UNHANDLED_EXCEPTION)", async () => {
    semsDev();
    ff = fakeFetch([{ url: /chain\//, response: respond({ status: 200, text: "null", headers: { "content-type": "application/json" } }) }]).install();
    expect(await code(resolve(UUID))).toBe("MIGRATE_TARGET_NOT_FOUND");
  });

  test("all-digit or non-uuid ids are refused before any request", async () => {
    semsDev();
    ff = fakeFetch([]).install();
    expect(await code(resolve("00000000000000000000000000000001"))).toBe("MIGRATE_TARGET_ID_INVALID");
    expect(await code(resolve("u1"))).toBe("MIGRATE_TARGET_ID_INVALID");
    expect(ff.requests).toHaveLength(0);
  });

  test("a method that comes back with another uuid → MIGRATE_TARGET_ID_MISMATCH", async () => {
    semsDev();
    ff = fakeFetch([{ url: /chain\//, response: { uuid: "ffffffffffffffffffffffffffffffff", name: "Create activity" } }]).install();
    expect(await code(resolve(UUID))).toBe("MIGRATE_TARGET_ID_MISMATCH");
  });

  test("NEW-2: a body that stalls keeps HTTP_TIMEOUT (was swallowed into MIGRATE_TARGET_NOT_FOUND)", async () => {
    semsDev();
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
      expect(err.details?.preflightEnv).toBe("sems-dev");
    } finally {
      if (prev === undefined) delete process.env.BELZ_HTTP_TIMEOUT_MS;
      else process.env.BELZ_HTTP_TIMEOUT_MS = prev;
    }
  });

  test("a real method resolves with its name", async () => {
    semsDev();
    ff = fakeFetch([{ url: /chain\//, response: { uuid: UUID, name: "belz.thing" } }]).install();
    const r = await resolve(UUID);
    expect(r?.targets[0]).toMatchObject({ resolvedId: UUID, name: "belz.thing" });
  });
});

describe("OTH-R25: module and migration-id flags", () => {
  const base = ["--profile", "devsems_qasems", "--ids", UUID];
  test("--module with --module-custom → MIGRATE_MODULE_CONFLICT", async () => {
    expect(await code(parseMigrateRunArgs([...base, "--module", "PD", "--module-custom", "X"]))).toBe("MIGRATE_MODULE_CONFLICT");
  });
  test("report/status modules need --migration-id", async () => {
    for (const m of ["AD_COMPARISON_REPORT", "PD_MIGRATION_STATUS"]) {
      expect(await code(parseMigrateRunArgs(["--profile", "devsems_qasems", "--module", m]))).toBe("MIGRATE_MIGRATION_ID_REQUIRED");
    }
    const ok = await parseMigrateRunArgs(["--profile", "devsems_qasems", "--module", "AD_COMPARISON_REPORT", "--migration-id", "m-1"]);
    expect(ok.migrationId).toBe("m-1");
  });
});

describe("OTH-R26: --client vs profile", () => {
  test("a client that isn't the profile's group → MIGRATE_CLIENT_PROFILE_MISMATCH, nothing POSTed", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: JENKINS });
    ff = fakeFetch([JOB_PARAMS]).install();
    const r = await runCommand(runCmd, [
      "--profile", "devsems_qasems", "--client", "DNREC", "--module", "PD", "--ids", "p1", "--no-follow", "--yes",
    ], { env: "nsm-dev" });
    expect(r.envelope?.error?.code).toBe("MIGRATE_CLIENT_PROFILE_MISMATCH");
    expect((r.envelope?.error?.details as { expected: string }).expected).toBe("SEMS");
    expect(ff.requests.some((q) => q.method === "POST")).toBe(false);
  });
});

describe("OTH-R23: failures after the trigger carry the build reference", () => {
  const argv = ["--profile", "devsems_qasems", "--client", "SEMS", "--module", "PD", "--ids", "p1", "--no-follow", "--yes"];
  const trigger = [
    JOB_PARAMS,
    { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) },
    { method: "POST", url: `${JOB}/buildWithParameters`, response: respond({ status: 201, headers: { location: "https://jk.test/queue/item/7/" } }) },
  ];

  test("getBuild transport error → same code, details.buildNumber/buildUrl, do-not-rerun hint", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: JENKINS });
    ff = fakeFetch([
      ...trigger,
      { method: "GET", url: "https://jk.test/queue/item/7/api/json", response: { id: 7, executable: { number: 42, url: `${JOB}/42/` } } },
      { method: "GET", url: `${JOB}/42/api/json`, response: respond({ status: 502, text: "bad gateway" }) },
    ]).install();
    const r = await runCommand(runCmd, argv, { env: "nsm-dev" });
    const err = r.envelope?.error;
    expect(err?.code).toStartWith("MIGRATE_JENKINS");
    expect(err?.message).toContain("do NOT re-run");
    expect(err?.message).toContain("belz migrate status 42");
    expect(err?.details).toMatchObject({
      buildTriggered: true, buildNumber: 42, buildUrl: `${JOB}/42/`, queueUrl: "https://jk.test/queue/item/7/",
    });
  });

  test("queue cancelled before a build number → details.queueUrl", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: JENKINS });
    ff = fakeFetch([
      ...trigger,
      { method: "GET", url: "https://jk.test/queue/item/7/api/json", response: { id: 7, cancelled: true, why: "x" } },
    ]).install();
    const r = await runCommand(runCmd, argv, { env: "nsm-dev" });
    expect(r.envelope?.error?.code).toBe("MIGRATE_JENKINS_QUEUE_CANCELLED");
    expect(r.envelope?.error?.details).toMatchObject({ buildTriggered: true, queueUrl: "https://jk.test/queue/item/7/" });
  });

  test("2xx trigger without a queue Location still says a build was triggered", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: JENKINS });
    ff = fakeFetch([
      JOB_PARAMS,
      { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) },
      { method: "POST", url: `${JOB}/buildWithParameters`, response: respond({ status: 201 }) },
    ]).install();
    const r = await runCommand(runCmd, argv, { env: "nsm-dev" });
    expect(r.envelope?.error?.code).toBe("MIGRATE_JENKINS_NO_QUEUE_LOCATION");
    expect(r.envelope?.error?.details).toMatchObject({ buildTriggered: true, jobUrl: `${JOB}/` });
  });
});
