// K18: a profile (or env pair) with no route names the routes its client does
// have, from the job's PROFILE_NAME choices (sanitized capture: ACME has
// dev→qa, qa→stage, qa→uat, stage→stage2, uat→stage, dev→uat; no dev→stage).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { fakeFetch, type FakeFetch, fixture, respond, runCommand, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
import { groupProfiles, MIGRATION_PROFILES_CACHE_PATH, parseMigrateRunArgs, routeHint } from "../../lib";
import runCmdModule from "../../commands/run/index";

const runCmd = { ...runCmdModule, envAware: false };
const PARAMS_PATH = `${import.meta.dir}/../fixtures/real/job-parameters.json`;
const params = (await Bun.file(PARAMS_PATH).json()) as { property: Array<{ parameterDefinitions?: Array<{ name: string; choices?: string[] }> }> };
const choices = params.property.flatMap((p) => p.parameterDefinitions ?? []).find((d) => d.name === "PROFILE_NAME")!.choices!;
const GROUPS = groupProfiles(choices);
const JENKINS = { baseUrl: "https://jk.test", user: "u", password: "p", passwordEncoding: "plain" as const, migrationJob: "A/b" };

let cfg: TempEnvConfig | null = null;
let ff: FakeFetch | null = null;
beforeEach(() => rmSync(MIGRATION_PROFILES_CACHE_PATH, { force: true }));
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  rmSync(MIGRATION_PROFILES_CACHE_PATH, { force: true });
});

describe("routeHint", () => {
  test("a missing profile: the client's routes, the missing pair, and a two-build path", () => {
    cfg = withTempEnvConfig({ envs: {} });
    const hint = routeHint(GROUPS, { profile: "devacme_stageacme" })!;
    expect(hint.text).toStartWith("ACME has dev→qa, qa→stage, qa→uat, stage→stage2, uat→stage, dev→uat; no dev→stage.");
    expect(hint.text).toContain("Two builds get there: dev→qa (devacme_qaacme), then qa→stage (qaacme_stageacme).");
    expect(hint.via).toEqual(["devacme_qaacme", "qaacme_stageacme"]);
    expect(hint.groups).toHaveLength(1);
    expect(hint.groups[0]!.client).toBe("ACME");
  });

  test("an env pair: env names matched to segments (no mapping needed); a direct route is suggested", () => {
    cfg = withTempEnvConfig({ envs: {} });
    const hint = routeHint(GROUPS, { sourceEnv: "acme-qa", targetEnv: "acme-stage" })!;
    expect(hint.suggested).toBe("qaacme_stageacme");
    expect(hint.text).toContain("use --profile qaacme_stageacme");
    expect(routeHint(GROUPS, { sourceEnv: "acme-dev", targetEnv: "acme-stage" })!.text).toContain("no acme-dev→acme-stage");
  });

  test("nothing (or too much) matches → null", () => {
    cfg = withTempEnvConfig({ envs: {} });
    expect(routeHint(GROUPS, { profile: "foo_bar" })).toBeNull();
    expect(routeHint(GROUPS, { profile: "nounderscore" })).toBeNull();
    // a bare "qa" names a segment of nearly every client
    expect(routeHint(GROUPS, { sourceEnv: "qa", targetEnv: "stage" })).toBeNull();
  });
});

describe("errors name the routes", () => {
  const JOB_PARAMS = { method: "GET", url: /\/api\/json\?tree=property/, response: fixture(PARAMS_PATH) };

  test("MIGRATE_PROFILE_NOT_FOUND lists the client's routes (no build, no POST)", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: {} } });
    ff = fakeFetch([JOB_PARAMS, { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) }]).install();
    const r = await runCommand(runCmd, ["--profile", "devacme_stageacme", "--module", "AD_Method", "--ids", "4bbd77bdfb3ae3d4aadda969b4ec9cf8", "--yes", "--quiet"]);
    const err = r.envelope?.error;
    expect(err?.code).toBe("MIGRATE_PROFILE_NOT_FOUND");
    expect(err?.message).toContain("ACME has dev→qa, qa→stage");
    expect(err?.message).toContain("no dev→stage");
    expect(err?.details).toMatchObject({ profile: "devacme_stageacme", via: ["devacme_qaacme", "qaacme_stageacme"] });
    expect(ff.requests.some((q) => q.method === "POST")).toBe(false);
  });

  test("MIGRATE_INVALID_ENV_PAIR lists the routes and suggests the profile", async () => {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: {} } });
    ff = fakeFetch([JOB_PARAMS]).install();
    const err = await parseMigrateRunArgs(["--module", "PD", "--ids", "a", "--source-env", "acme-qa", "--target-env", "acme-stage"]).then(
      () => null,
      (e) => e,
    );
    expect(err?.code).toBe("MIGRATE_INVALID_ENV_PAIR");
    expect(err?.message).toContain("jenkins.profileEnvs");
    expect(err?.message).toContain("use --profile qaacme_stageacme");
    expect(err?.details).toMatchObject({ suggestedProfile: "qaacme_stageacme" });
  });

  test("without Jenkins config the env-pair error stays as it was", async () => {
    cfg = withTempEnvConfig({ envs: {} });
    ff = fakeFetch([]).install();
    const err = await parseMigrateRunArgs(["--module", "PD", "--ids", "a", "--source-env", "acme-qa", "--target-env", "acme-stage"]).then(
      () => null,
      (e) => e,
    );
    expect(err?.code).toBe("MIGRATE_INVALID_ENV_PAIR");
    expect(err?.details?.routes).toBeUndefined();
    expect(ff.requests).toHaveLength(0);
  });
});
