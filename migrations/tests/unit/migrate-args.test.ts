import { describe, expect, test } from "bun:test";
import { parseMigrateArgs, deriveNsmProfile } from "../../lib/args";

describe("migrate args", () => {
  test("parses profiles args", async () => {
    const parsed = await parseMigrateArgs(["profiles", "--refresh", "--raw"]);
    expect(parsed.action).toBe("profiles");
    if (parsed.action === "profiles") {
      expect(parsed.refresh).toBe(true);
      expect(parsed.raw).toBe(true);
    }
  });

  test("parses run args with explicit profile", async () => {
    const parsed = await parseMigrateArgs([
      "run",
      "--module",
      "PD",
      "--ids",
      "a,b,c",
      "--profile",
      "devncdns_qancdns",
      "--raw",
    ]);

    expect(parsed.action).toBe("run");
    if (parsed.action === "run") {
      expect(parsed.moduleName).toBe("PD");
      expect(parsed.ids).toEqual(["a", "b", "c"]);
      expect(parsed.profile).toBe("devncdns_qancdns");
      expect(parsed.useCrud).toBe("Y");
      expect(parsed.isAsync).toBe("Y");
      expect(parsed.migrateDependents).toBe("N");
      expect(parsed.raw).toBe(true);
    }
  });

  test("derives profile from source and target env", async () => {
    const parsed = await parseMigrateArgs([
      "run",
      "--module",
      "AD",
      "--ids",
      "x",
      "--source-env",
      "nsm-qa",
      "--target-env",
      "nsm-uat",
    ]);

    expect(parsed.action).toBe("run");
    if (parsed.action === "run") {
      expect(parsed.profile).toBe("qancdns_uatncdns");
      expect(parsed.moduleName).toBe("AD");
    }
  });

  test("loads ids from file", async () => {
    const tmpPath = `/tmp/migrate-ids-${Date.now()}.txt`;
    await Bun.write(tmpPath, "id-1\nid-2,id-3");

    const parsed = await parseMigrateArgs([
      "run",
      "--module",
      "PD",
      "--ids-file",
      tmpPath,
      "--profile",
      "devncdns_qancdns",
    ]);

    expect(parsed.action).toBe("run");
    if (parsed.action === "run") {
      expect(parsed.ids).toEqual(["id-1", "id-2", "id-3"]);
    }
  });

  test("throws on missing ids", async () => {
    try {
      await parseMigrateArgs(["run", "--module", "PD", "--profile", "devncdns_qancdns"]);
      throw new Error("expected parseMigrateArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("MIGRATE_IDS_REQUIRED");
    }
  });

  test("throws on invalid yes/no value", async () => {
    try {
      await parseMigrateArgs([
        "run",
        "--module",
        "PD",
        "--ids",
        "abc",
        "--profile",
        "devncdns_qancdns",
        "--crud",
        "maybe",
      ]);
      throw new Error("expected parseMigrateArgs to throw");
    } catch (error: any) {
      expect(error.code).toBe("MIGRATE_INVALID_FLAG_VALUE");
    }
  });

  test("deriveNsmProfile helper", () => {
    expect(deriveNsmProfile("nsm-stage", "nsm-stage2")).toBe("stgncdns_stg2ncdns");
  });
});
