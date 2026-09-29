import { describe, expect, test } from "bun:test";
import { resolveSqlDatabase, normalizeSqlDatabases } from "../../lib/sql/selector";

const rawDatabases = [
  {
    id: 55,
    nickname: "ORB_Read_DB",
    authUsageType: "ALL",
    derivedAuthType: "BASIC",
    fields: [
      { fieldName: "source", fieldValue: "postgres" },
      { fieldName: "host", fieldValue: "read-host" },
      { fieldName: "port", fieldValue: "5432" },
    ],
  },
  {
    id: 18,
    nickname: "ORB_QA_DB",
    authUsageType: "ALL",
    derivedAuthType: "BASIC",
    fields: [
      { fieldName: "source", fieldValue: "postgres" },
      { fieldName: "host", fieldValue: "qa-host" },
      { fieldName: "port", fieldValue: "5432" },
    ],
  },
];

describe("SQL database selector", () => {
  test("normalizes database fields", () => {
    const normalized = normalizeSqlDatabases(rawDatabases as any);
    expect(normalized[0]?.source).toBe("postgres");
    expect(normalized[0]?.host).toBe("read-host");
  });

  test("resolves explicit --db nickname", () => {
    const normalized = normalizeSqlDatabases(rawDatabases as any);
    const resolved = resolveSqlDatabase(normalized, {
      requested: "orb_qa_db",
      fallbackNickname: "ORB_Read_DB",
    });

    expect(resolved.selected.nickname).toBe("ORB_QA_DB");
    expect(resolved.selectedBy).toBe("--db");
  });

  test("resolves explicit --db id", () => {
    const normalized = normalizeSqlDatabases(rawDatabases as any);
    const resolved = resolveSqlDatabase(normalized, {
      requested: "55",
      fallbackNickname: "ORB_Read_DB",
    });

    expect(resolved.selected.id).toBe(55);
    expect(resolved.selectedBy).toBe("--db");
  });

  test("resolves env default", () => {
    const normalized = normalizeSqlDatabases(rawDatabases as any);
    const resolved = resolveSqlDatabase(normalized, {
      envDefault: "ORB_QA_DB",
      fallbackNickname: "ORB_Read_DB",
    });

    expect(resolved.selected.nickname).toBe("ORB_QA_DB");
    expect(resolved.selectedBy).toBe("env");
  });

  test("falls back to ORB_Read_DB", () => {
    const normalized = normalizeSqlDatabases(rawDatabases as any);
    const resolved = resolveSqlDatabase(normalized, {
      fallbackNickname: "ORB_Read_DB",
    });

    expect(resolved.selected.nickname).toBe("ORB_Read_DB");
    expect(resolved.selectedBy).toBe("fallback");
  });

  test("throws when requested database is missing", () => {
    const normalized = normalizeSqlDatabases(rawDatabases as any);

    try {
      resolveSqlDatabase(normalized, {
        requested: "does-not-exist",
        fallbackNickname: "ORB_Read_DB",
      });
      throw new Error("expected resolveSqlDatabase to throw");
    } catch (error: any) {
      expect(error.code).toBe("SQL_DB_NOT_FOUND");
    }
  });
});
