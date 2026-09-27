// MG-1 / MG-2 regressions for `belz migrate run` argument parsing.
import { describe, test, expect } from "bun:test";
import {
  parseMigrateRunArgs,
  envPairFromProfile,
  suggestFlag,
  resolveMigrationTargets,
} from "../../lib";

const BASE = ["--profile", "devsems_qasems", "--module", "PD", "--ids", "abc"];

async function codeOf(p: Promise<unknown>): Promise<{ code?: string; details?: any; message: string }> {
  try {
    await p;
  } catch (err) {
    return err as any;
  }
  throw new Error("expected rejection");
}

describe("MG-1: unknown flags are rejected with a did-you-mean", () => {
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
      expect(err.details.suggestion).toBe(suggestion);
      expect(err.message).toContain(`Did you mean '${suggestion}'`);
    });
  }

  test("a wildly unknown flag gets no suggestion", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--frobnicate"]));
    expect(err.code).toBe("MIGRATE_UNKNOWN_FLAG");
    expect(err.details.suggestion).toBeNull();
  });

  test("boolean flag with =value is rejected (--dry-run=true must not run for real)", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--dry-run=true"]));
    expect(err.code).toBe("MIGRATE_INVALID_FLAG_VALUE");
  });

  test("stray positional (e.g. space in --ids list) is rejected", async () => {
    const err = await codeOf(parseMigrateRunArgs(["--profile", "devsems_qasems", "--module", "PD", "--ids", "a,", "b"]));
    expect(err.code).toBe("MIGRATE_UNEXPECTED_ARG");
  });

  test("all known flags still parse", async () => {
    const parsed = await parseMigrateRunArgs([
      ...BASE, "--client", "SEMS", "--migration-id", "m1", "--async", "Y", "--migrate-dependents=N",
      "--devops-tag", "develop", "--out", "/tmp/x", "--dry-run", "--no-auto-approve", "--raw", "--quiet", "--no-follow",
      "--source-env", "sems-dev", "--target-env=sems-qa",
    ]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.autoApprove).toBe(false);
    expect(parsed.asyncMigration).toBe("Y");
    expect(parsed.follow).toBe(false);
    expect(parsed.sourceEnv).toBe("sems-dev");
  });

  test("suggestFlag helper", () => {
    expect(suggestFlag("--dryrun")).toBe("--dry-run");
    expect(suggestFlag("--zzzzzzzzzz")).toBeUndefined();
  });
});

describe("MG-2: profile ↔ env consistency", () => {
  test("envPairFromProfile derives the env family", () => {
    expect(envPairFromProfile("devsems_qasems")).toEqual({ sourceEnv: "sems-dev", targetEnv: "sems-qa" });
    expect(envPairFromProfile("qancdns_stgncdns")).toEqual({ sourceEnv: "nsm-qa", targetEnv: "nsm-stage" });
    expect(envPairFromProfile("qa1cdnrec_qa2cdnrec")).toBeNull();
  });

  test("--source-env contradicting the profile → MIGRATE_ENV_PROFILE_MISMATCH", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--source-env", "nsm-qa"]));
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_MISMATCH");
  });

  test("--target-env contradicting the profile → MIGRATE_ENV_PROFILE_MISMATCH", async () => {
    const err = await codeOf(parseMigrateRunArgs([...BASE, "--source-env", "sems-dev", "--target-env", "sems-stage"]));
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_MISMATCH");
  });

  test("consistent envs are accepted", async () => {
    const parsed = await parseMigrateRunArgs([...BASE, "--source-env", "sems-dev", "--target-env", "sems-qa"]);
    expect(parsed.profile).toBe("devsems_qasems");
  });

  test("unknown profile family + lone --source-env → MIGRATE_ENV_PROFILE_UNVERIFIED", async () => {
    const err = await codeOf(
      parseMigrateRunArgs(["--profile", "qa1cdnrec_qa2cdnrec", "--module", "PD", "--ids", "a", "--source-env", "nsm-qa"]),
    );
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_UNVERIFIED");
  });

  test("unknown profile family + both envs explicit is accepted", async () => {
    const parsed = await parseMigrateRunArgs([
      "--profile", "qa1cdnrec_qa2cdnrec", "--module", "PD", "--ids", "a", "--source-env", "x-qa1", "--target-env", "x-qa2",
    ]);
    expect(parsed.sourceEnv).toBe("x-qa1");
  });

  test("no env flags → profile alone is fine", async () => {
    const parsed = await parseMigrateRunArgs(BASE);
    expect(parsed.sourceEnv).toBeUndefined();
  });

  test("resolveMigrationTargets refuses a contradicting sourceEnv before any fetch", async () => {
    const err = await codeOf(
      resolveMigrationTargets({ profile: "devsems_qasems", sourceEnv: "nsm-qa", migrateType: "PD", ids: ["x"] }),
    );
    expect(err.code).toBe("MIGRATE_ENV_PROFILE_MISMATCH");
  });
});
