import { describe, expect, test } from "bun:test";
import { createMigrateCommand } from "../../../cli/commands/migrate";
import type { ParsedMigrationOutput } from "../../lib/migration";

describe("migrate command", () => {
  test("profiles action returns resolved profiles", async () => {
    const command = createMigrateCommand({
      discoverProfiles: async () => ({
        source: "live",
        fetchedAt: "2026-02-27T00:00:00.000Z",
        profiles: ["devncdns_qancdns"],
      }),
    });

    const result = await command.execute({ action: "profiles", refresh: false, raw: false }, {} as any);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe("profiles");
      expect(result.data.profiles[0]).toBe("devncdns_qancdns");
    }
  });

  test("run action succeeds and returns execution summary", async () => {
    const parsedOutput: ParsedMigrationOutput = {
      cleanedOutput: "All migrations completed successfully",
      successDetected: true,
      failureDetected: false,
      failureHints: [],
      migrationId: "mig-1",
      statusUrl: "https://example.com/status",
      reportSummary: {
        migrationId: "mig-1",
        migrationStatus: "COMPLETED",
        statusCode: 200,
        entityCount: 1,
        mismatchCount: 0,
        successCount: 1,
        failedCount: 0,
      },
    };

    const command = createMigrateCommand({
      discoverProfiles: async () => ({
        source: "live",
        fetchedAt: "2026-02-27T00:00:00.000Z",
        profiles: ["devncdns_qancdns"],
      }),
      startExecution: async () => ({
        executionId: "3028",
        status: 200,
        body: "3028",
      }),
      streamExecution: async () => ({
        executionId: "3028",
        events: [],
        outputText: parsedOutput.cleanedOutput,
      }),
      parseOutput: () => parsedOutput,
      cleanupExecution: async () => ({ ok: true, status: 200 }),
    });

    const result = await command.execute(
      {
        action: "run",
        moduleName: "PD",
        ids: ["id-1"],
        profile: "devncdns_qancdns",
        useCrud: "Y",
        isAsync: "Y",
        migrateDependents: "N",
        cleanup: "auto",
        scriptName: "NCDNS: Migrate Source DB to Target DB",
        raw: false,
      },
      {} as any
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe("run");
      expect(result.data.execution.executionId).toBe("3028");
      expect(result.data.execution.success).toBe(true);
      expect(result.data.report?.migrationStatus).toBe("COMPLETED");
    }
  });

  test("run action throws when migration is unsuccessful", async () => {
    const parsedOutput: ParsedMigrationOutput = {
      cleanedOutput: "Migration failed",
      successDetected: false,
      failureDetected: true,
      failureHints: ["FAILED"],
    };

    const command = createMigrateCommand({
      discoverProfiles: async () => ({
        source: "live",
        fetchedAt: "2026-02-27T00:00:00.000Z",
        profiles: ["devncdns_qancdns"],
      }),
      startExecution: async () => ({
        executionId: "3028",
        status: 200,
        body: "3028",
      }),
      streamExecution: async () => ({
        executionId: "3028",
        events: [],
        outputText: "Migration failed",
      }),
      parseOutput: () => parsedOutput,
      cleanupExecution: async () => ({ ok: true }),
    });

    try {
      await command.execute(
        {
          action: "run",
          moduleName: "PD",
          ids: ["id-1"],
          profile: "devncdns_qancdns",
          useCrud: "Y",
          isAsync: "Y",
          migrateDependents: "N",
          cleanup: "auto",
          scriptName: "NCDNS: Migrate Source DB to Target DB",
          raw: false,
        },
        {} as any
      );
      throw new Error("expected execute to throw");
    } catch (error: any) {
      expect(error.code).toBe("MIGRATE_RUN_FAILED");
    }
  });
});
