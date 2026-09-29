// `belz migrate run` argument parsing: unknown flags and profile ↔ env consistency.
import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { caughtCliError as codeOf, withTempEnvConfig, type TempEnvConfig } from "@belzabar/core/testing";
import {
  parseMigrateRunArgs,
  envPairFromProfile,
  resolveMigrationTargets,
} from "../../lib";
import statusCmd from "../../commands/status/index";
import logsCmd from "../../commands/logs/index";
import profilesCmd from "../../commands/profiles/index";
import runCmd from "../../commands/run/index";

/** Profile segment → env mapping (config `jenkins.profileEnvs`); belz has no built-in one. */
const PROFILE_ENVS = { devacme: "acme-dev", qaacme: "acme-qa", stageacme: "acme-stage", qagm: "gm-qa", stagegm: "gm-stage", qabravo: "orb-qa", stgbravo: "orb-stage" };

// Every test sees the mapping (parseMigrateRunArgs reads it from config).
let cfg: TempEnvConfig | null = null;
beforeEach(() => {
  cfg = withTempEnvConfig({ envs: { t: { url: "https://t.test" } }, jenkins: { profileEnvs: PROFILE_ENVS } });
});
afterEach(() => {
  cfg?.restore();
  cfg = null;
});

const BASE = ["--profile", "devacme_qaacme", "--module", "PD", "--ids", "abc"];

describe("unknown flags are rejected with a did-you-mean", () => {
  const typos: Array<[string[], string]> = [
    [["--dryrun"], "--dry-run"],
    [["--dry_run"], "--dry-run"],
    [["--no-autoapprove"], "--no-auto-approve"],
    [["--no-auto-aprove"], "--no-auto-approve"],
    [["--asynk", "Y"], "--async"],
    [["--asynk=Y"], "--async"],
    [["--migrate-dependent", "Y"], "--migrate-dependents"],
    [["--nofollow"], "--no-follow"],
    [["--proflie", "x"], "--profile"],
    [["--id", "x"], "--ids"],
  ];
  for (const [extra, suggestion] of typos) {
    test(`${extra.join(" ")} → MIGRATE_UNKNOWN_FLAG (did you mean ${suggestion})`, async () => {
      const err = await codeOf(parseMigrateRunArgs([...BASE, ...extra]));
      expect(err.code).toBe("MIGRATE_UNKNOWN_FLAG");
      expect((err.details as { suggestion?: string | null }).suggestion).toBe(suggestion);
      expect(err.message).toContain(`Did you mean '${suggestion}'`);
    });
  }

  test("a wildly unknown flag gets no suggestion", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--frobnicate"]));
    expect(err.code).toBe("MIGRATE_UNKNOWN_FLAG");
    expect((err.details as { suggestion?: string | null }).suggestion).toBeNull();
  });

  test("boolean flag with =value is rejected (--dry-run=true must not run for real)", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--dry-run=true"]));
    expect(err.code).toBe("MIGRATE_INVALID_FLAG_VALUE");
  });

  test("stray positional (e.g. space in --ids list) is rejected", async () => {
    const err = await codeOf(parseMigrateRunArgs(["--profile", "devacme_qaacme", "--module", "PD", "--ids", "a,", "b"]));
    expect(err.code).toBe("MIGRATE_UNEXPECTED_ARG");
  });

  test("all known flags still parse", async () => {
    const parsed = await parseMigrateRunArgs([
      ...BASE, "--client", "ACME", "--migration-id", "m1", "--async", "Y", "--migrate-dependents=N",
      "--devops-tag", "develop", "--out", "/tmp/x", "--dry-run", "--no-auto-approve", "--quiet", "--no-follow",
      "--source-env", "acme-dev", "--target-env=acme-qa",
    ]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.autoApprove).toBe(false);
    expect(parsed.asyncMigration).toBe("Y");
    expect(parsed.follow).toBe(false);
    expect(parsed.sourceEnv).toBe("acme-dev");
  });
});

describe("profile ↔ env consistency", () => {
  test("envPairFromProfile derives the env family from config jenkins.profileEnvs", () => {
    expect(envPairFromProfile("devacme_qaacme")).toEqual({ sourceEnv: "acme-dev", targetEnv: "acme-qa" });
    expect(envPairFromProfile("QAbravo_stgbravo")).toEqual({ sourceEnv: "orb-qa", targetEnv: "orb-stage" });
    expect(envPairFromProfile("qa1cdelta_qa2cdelta")).toBeNull();
    // no mapping configured → nothing is derivable (no built-in project knowledge)
    cfg?.restore();
    cfg = withTempEnvConfig({ envs: { t: { url: "https://t.test" } } });
    expect(envPairFromProfile("devacme_qaacme")).toBeNull();
  });

  test("--source-env/--target-env derive the profile through the mapping; unmapped → MIGRATE_INVALID_ENV_PAIR", async () => {
    const parsed = await parseMigrateRunArgs(["--module", "PD", "--ids", "a", "--source-env", "acme-dev", "--target-env", "acme-qa"]);
    expect(parsed.profile).toBe("devacme_qaacme");
    const err = await codeOf(parseMigrateRunArgs(["--module", "PD", "--ids", "a", "--source-env", "x-dev", "--target-env", "acme-qa"]));
    expect(err.code).toBe("MIGRATE_INVALID_ENV_PAIR");
    expect(err.message).toContain("jenkins.profileEnvs");
  });

  test("--source-env contradicting the profile → MIGRATE_ENV_PROFILE_MISMATCH", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--source-env", "orb-qa"]));
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_MISMATCH");
  });

  test("--target-env contradicting the profile → MIGRATE_ENV_PROFILE_MISMATCH", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--source-env", "acme-dev", "--target-env", "acme-stage"]));
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_MISMATCH");
  });

  test("consistent envs are accepted", async () => {
    const parsed = await parseMigrateRunArgs([...BASE, "--source-env", "acme-dev", "--target-env", "acme-qa"]);
    expect(parsed.profile).toBe("devacme_qaacme");
  });

  test("unknown profile family + lone --source-env → MIGRATE_ENV_PROFILE_UNVERIFIED", async () => {
    const err = await codeOf(
      parseMigrateRunArgs(["--profile", "qa1cdelta_qa2cdelta", "--module", "PD", "--ids", "a", "--source-env", "orb-qa"]),
    );
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_UNVERIFIED");
  });

  test("unknown profile family + both envs explicit is accepted", async () => {
    const parsed = await parseMigrateRunArgs([
      "--profile", "qa1cdelta_qa2cdelta", "--module", "PD", "--ids", "a", "--source-env", "x-qa1", "--target-env", "x-qa2",
    ]);
    expect(parsed.sourceEnv).toBe("x-qa1");
  });

  test("no env flags → profile alone is fine", async () => {
    const parsed = await parseMigrateRunArgs(BASE);
    expect(parsed.sourceEnv).toBeUndefined();
  });

  test("resolveMigrationTargets refuses a contradicting sourceEnv before any fetch", async () => {
    const err = await codeOf(
      resolveMigrationTargets({ profile: "devacme_qaacme", sourceEnv: "orb-qa", migrateType: "PD", ids: ["x"] }),
    );
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_MISMATCH");
  });
});

describe("defineArgs behaviour", () => {
  test("the no-op --raw is gone", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--raw"]));
    expect(err.code).toBe("MIGRATE_UNKNOWN_FLAG");
  });

  test("a value flag followed by a flag is MISSING_VALUE (not silently undefined)", async () => {
    const err = await codeOf(parseMigrateRunArgs(["--profile", "--module", "PD", "--ids", "a"]));
    expect(err.code).toBe("MISSING_VALUE");
  });

  test("--async must be Y or N (case-insensitive)", async () => {
    expect((await parseMigrateRunArgs([...BASE, "--async", "y"])).asyncMigration).toBe("Y");
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--async", "maybe"]));
    expect(err.code).toBe("MIGRATE_INVALID_FLAG_VALUE");
  });

  test("--ids with --ids-file → MIGRATE_IDS_CONFLICT", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--ids-file", "x.txt"]));
    expect(err.code).toBe("MIGRATE_IDS_CONFLICT");
  });

  test("--module-name is an alias of --module", async () => {
    const parsed = await parseMigrateRunArgs(["--profile", "devacme_qaacme", "--module-name", "pd", "--ids", "a"]);
    expect(parsed.migrateType).toBe("PD");
  });
});

describe("status / logs / profiles", () => {
  test("build numbers are digits only", async () => {
    for (const mod of [statusCmd, logsCmd]) {
      expect(mod.parseArgs!(["743"], {} as any)).toMatchObject({ buildNumber: 743 });
      for (const bad of ["12abc", "0", "-5", "1.5"]) {
        const err = await codeOf(Promise.resolve().then(() => mod.parseArgs!([bad], {} as any)));
        expect(err.code).toBe("MIGRATE_BUILD_NUMBER_INVALID");
      }
      const missing = await codeOf(Promise.resolve().then(() => mod.parseArgs!([], {} as any)));
      expect(missing.code).toBe("MIGRATE_BUILD_NUMBER_REQUIRED");
      const unknown = await codeOf(Promise.resolve().then(() => mod.parseArgs!(["1", "--raw"], {} as any)));
      expect(unknown.code).toBe("UNKNOWN_FLAG");
    }
  });

  test("profiles --client is parsed (checked against the Jenkins groups at run time)", () => {
    expect(profilesCmd.parseArgs!(["--client", " acme "], {} as any)).toEqual({ action: "profiles", refresh: false, client: "acme" });
    expect(profilesCmd.parseArgs!(["--refresh"], {} as any)).toEqual({ action: "profiles", refresh: true, client: undefined });
  });

  test("migrate run is a write", () => {
    expect(runCmd.writes).toBe(true);
  });
});
