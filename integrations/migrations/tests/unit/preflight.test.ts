// `migrate run` pre-flight (resolve-targets): a skipped pre-flight must warn,
// never skip silently; PD drafts swap to their
// published sibling; auth failures say what to do; the caller's env is restored.
import { afterEach, describe, expect, test } from "bun:test";
import { Config } from "@belzabar/core";
import { caughtCliError, fakeFetch, fixture, respond, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { resolveMigrationTargets } from "../../lib";
import runCmdModule from "../../commands/run/index";

// The `migrate` namespace is not env-aware (targets come from the profile).
const runCmd = { ...runCmdModule, envAware: false };

// An explicit --client is checked against the profile's Jenkins group.
const JOB_PARAMS = { method: "GET", url: /\/api\/json\?tree=property/, response: fixture(`${import.meta.dir}/../fixtures/real/job-parameters.json`) };

/** Profile segment → env mapping (config `jenkins.profileEnvs`); wi-impl has no built-in one. */
const PROFILE_ENVS = { devacme: "acme-dev", qaacme: "acme-qa", stageacme: "acme-stage", qagm: "gm-qa", stagegm: "gm-stage", qabravo: "orb-qa", stgbravo: "orb-stage" };

let cfg: TempEnvConfig | null = null;
let ff: FakeFetch | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
});

function collect() {
  const warnings: string[] = [];
  return { warnings, warn: (m: string) => warnings.push(m) };
}

describe("migrate pre-flight", () => {
  test("ACME profile whose source env is not configured → warns and skips (no request)", async () => {
    cfg = withTempEnvConfig({ envs: { "orb-qa": { url: "https://orb-qa.test" } }, jenkins: { profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([]).install();
    const w = collect();
    const res = await resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "PD", ids: ["p1"], warn: w.warn });
    expect(res).toBeNull();
    expect(w.warnings).toHaveLength(1);
    expect(w.warnings[0]).toContain("'acme-dev', which is not configured");
    expect(w.warnings[0]).toContain("PD draft id will fail");
    expect(ff.requests).toHaveLength(0);
  });

  test("GM profile, AD module, env not configured → warns too", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { profileEnvs: PROFILE_ENVS } });
    const w = collect();
    const res = await resolveMigrationTargets({ profile: "qagm_stagegm", migrateType: "AD_Method", ids: ["u1"], warn: w.warn });
    expect(res).toBeNull();
    expect(w.warnings[0]).toContain("'gm-qa', which is not configured");
  });

  test("unknown profile family without --source-env → warns (was a silent skip)", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { profileEnvs: PROFILE_ENVS } });
    const w = collect();
    const res = await resolveMigrationTargets({ profile: "foo_bar", migrateType: "PD", ids: ["x"], warn: w.warn });
    expect(res).toBeNull();
    expect(w.warnings[0]).toContain("can't derive the source env from profile 'foo_bar'");
  });

  test("comparison-report modules need no pre-flight and raise no warning", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { profileEnvs: PROFILE_ENVS } });
    const w = collect();
    expect(await resolveMigrationTargets({ profile: "foo_bar", migrateType: "AD_COMPARISON_REPORT", ids: ["x"], warn: w.warn })).toBeNull();
    expect(w.warnings).toEqual([]);
  });

  test("configured ACME source env: PD draft swapped for its published id, env restored", async () => {
    cfg = withTempEnvConfig({ envs: { "acme-dev": { url: "https://acme-dev.test" }, "orb-dev": { url: "https://orb-dev.test" } }, jenkins: { profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([
      { method: "GET", url: "https://acme-dev.test/rest/api/pagedesigner/pages/draft1", response: { name: "Home", status: "DRAFT", referenceId: "pub1" } },
    ]).install();
    const before = Config.activeEnv.name;
    const w = collect();
    const res = await resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "PD", ids: ["draft1"], warn: w.warn });
    expect(res?.sourceEnv).toBe("acme-dev");
    expect(res?.resolvedIds).toEqual(["pub1"]);
    expect(res?.targets[0]).toMatchObject({ inputId: "draft1", resolvedId: "pub1", swapped: true, name: "Home" });
    expect(w.warnings).toEqual([]);
    expect(Config.activeEnv.name).toBe(before);
    expect(Config.envWasExplicit).toBe(false);
  });

  test("a login failure on the source env says how to proceed and keeps its code", async () => {
    cfg = withTempEnvConfig({ envs: { "acme-dev": { url: "https://acme-dev.test", token: null } }, jenkins: { profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([{ url: /acme-dev\.test/, response: respond({ status: 401, json: { message: "bad creds" } }) }]).install();
    const err = await caughtCliError(
      resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: ["4d075e621c93206fb95d84795fc05e00"] }),
    );
    expect(String(err.code)).not.toStartWith("MIGRATE_");
    expect(err.message).toContain("Pre-flight id resolution on 'acme-dev' failed, so no build was triggered");
    expect(err.message).toContain("wi-impl config edit");
    expect(err.details).toMatchObject({ preflightEnv: "acme-dev" });
  });

  test("K18: an AD draft uuid is warned about (target published unchanged), naming the published uuid; not swapped", async () => {
    const DRAFT = "438b502717b979a6a8539691d673fc39";
    const PUBLISHED = "41f705aff6c768c033b4ad9840b69dde";
    const LONE = "4bf743d021f23cc8510581e88c23b43b";
    cfg = withTempEnvConfig({ envs: { "acme-dev": { url: "https://acme-dev.test" } }, jenkins: { profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([
      { url: `https://acme-dev.test/rest/api/automation/chain/${DRAFT}`, response: { uuid: DRAFT, name: "program.sync", state: "DRAFT", automationState: "DRAFT", referenceId: PUBLISHED } },
      { url: `https://acme-dev.test/rest/api/automation/chain/${PUBLISHED}`, response: { uuid: PUBLISHED, name: "program.sync", automationState: "PUBLISHED", referenceId: DRAFT } },
      { url: `https://acme-dev.test/rest/api/automation/chain/${LONE}`, response: { uuid: LONE, name: "never.published", automationState: "DRAFT" } },
      { url: /\/chain\/v2\//, response: { steps: [] } },
    ]).install();
    const w = collect();
    const res = await resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: [DRAFT, PUBLISHED, LONE], warn: w.warn });
    expect(res?.resolvedIds).toEqual([DRAFT, PUBLISHED, LONE]);
    expect(res?.targets[0]).toMatchObject({ status: "DRAFT", publishedId: PUBLISHED, swapped: false });
    expect(res?.targets[1]).toMatchObject({ status: "PUBLISHED", swapped: false });
    expect(res?.targets[1]!.publishedId).toBeUndefined();
    const drafts = w.warnings.filter((m) => m.includes("AD DRAFT"));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toContain(`program.sync (${DRAFT}) is an AD DRAFT (editor) uuid: the build migrates only the draft`);
    expect(drafts[0]).toContain(`migrate its published uuid ${PUBLISHED} instead`);
    expect(drafts[1]).toContain("no published version on 'acme-dev'");
  });

  test("a 404 keeps the specific MIGRATE_TARGET_NOT_FOUND", async () => {
    cfg = withTempEnvConfig({ envs: { "acme-dev": { url: "https://acme-dev.test" } }, jenkins: { profileEnvs: PROFILE_ENVS } });
    ff = fakeFetch([{ url: /chain\/abcdefabcdefabcdefabcdefabcdefab/, response: respond({ status: 404, json: {} }) }]).install();
    await expect(
      resolveMigrationTargets({ profile: "devacme_qaacme", migrateType: "AD_Method", ids: ["abcdefabcdefabcdefabcdefabcdefab"] }),
    ).rejects.toMatchObject({ code: "MIGRATE_TARGET_NOT_FOUND" });
  });
});

// End to end through the runner with a fully faked Jenkins (nothing leaves the process).
describe("migrate run: skipped pre-flight surfaces in the envelope", () => {
  test("meta.warnings carries the skip; --dry-run still triggers a build with DRY_RUN=true", async () => {
    cfg = withTempEnvConfig({
      envs: {},
      jenkins: { profileEnvs: PROFILE_ENVS,  baseUrl: "https://jk.test", user: "u", password: "p", passwordEncoding: "plain", migrationJob: "A/b" },
    });
    const JOB = "https://jk.test/job/A/job/b";
    ff = fakeFetch([
      JOB_PARAMS,
      { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) },
      { method: "POST", url: `${JOB}/buildWithParameters`, response: respond({ status: 201, headers: { location: "https://jk.test/queue/item/7/" } }) },
      { method: "GET", url: "https://jk.test/queue/item/7/api/json", response: { id: 7, executable: { number: 42, url: `${JOB}/42/` } } },
      { method: "GET", url: `${JOB}/42/api/json`, response: { number: 42, url: `${JOB}/42/`, building: true, result: null, duration: 0, timestamp: 0, estimatedDuration: 0, actions: [] } },
    ]).install();

    const r = await runCommand(runCmd, [
      "--profile", "devacme_qaacme", "--client", "ACME", "--module", "PD", "--ids", "p1", "--dry-run", "--no-follow", "--yes",
    ]);
    expect(r.envelope?.ok).toBe(true);
    const warnings = (r.envelope?.meta as any).warnings as string[];
    expect(warnings.some((w) => w.includes("'acme-dev', which is not configured"))).toBe(true);
    const trigger = ff.requests.find((q) => q.method === "POST")!;
    const form = new URLSearchParams(trigger.body ?? "");
    expect(form.get("DRY_RUN")).toBe("true");
    expect(form.get("IDS")).toBe("p1");
  });
});

describe("migrate run: confirmation gate", () => {
  test("without --yes (--llm) nothing is POSTed: MIGRATE_CONFIRMATION_REQUIRED, dry run included", async () => {
    cfg = withTempEnvConfig({
      envs: {},
      jenkins: { profileEnvs: PROFILE_ENVS,  baseUrl: "https://jk.test", user: "u", password: "p", passwordEncoding: "plain", migrationJob: "A/b" },
    });
    ff = fakeFetch([JOB_PARAMS, { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) }]).install();
    for (const extra of [[], ["--dry-run"]]) {
      const r = await runCommand(runCmd, [
        "--profile", "devacme_qaacme", "--client", "ACME", "--module", "PD", "--ids", "p1", "--no-follow", ...extra,
      ]);
      expect(r.envelope?.error?.code).toBe("MIGRATE_CONFIRMATION_REQUIRED");
      expect((r.envelope?.error?.details as any).details).toMatchObject({ Profile: "devacme_qaacme", Ids: "p1" });
    }
    expect(ff.requests.some((q) => q.method === "POST")).toBe(false);
  });

  test("K18: an AD confirmation says the draft is copied too, and carries the pre-flight warnings", async () => {
    const DRAFT = "438b502717b979a6a8539691d673fc39";
    cfg = withTempEnvConfig({
      envs: { "acme-dev": { url: "https://acme-dev.test" } },
      jenkins: { profileEnvs: PROFILE_ENVS, baseUrl: "https://jk.test", user: "u", password: "p", passwordEncoding: "plain", migrationJob: "A/b" },
    });
    ff = fakeFetch([
      JOB_PARAMS,
      { url: `https://acme-dev.test/rest/api/automation/chain/${DRAFT}`, response: { uuid: DRAFT, name: "program.sync", automationState: "DRAFT", referenceId: "41f705aff6c768c033b4ad9840b69dde" } },
      { url: /\/chain\/v2\//, response: { steps: [] } },
    ]).install();
    const r = await runCommand(runCmd, ["--profile", "devacme_qaacme", "--module", "AD_Method", "--ids", DRAFT, "--quiet"]);
    expect(r.envelope?.error?.code).toBe("MIGRATE_CONFIRMATION_REQUIRED");
    const details = (r.envelope?.error?.details as any).details;
    expect(details.Copies).toContain("published version AND its draft");
    expect(details.Warnings).toContain("is an AD DRAFT (editor) uuid");
    expect(details.Warnings).toContain("Called-method check skipped: target env 'acme-qa' is not configured");
    expect(ff.requests.some((q) => q.method === "POST")).toBe(false);
  });
});

