// E4 / E13: a failed statement puts the database's own message in
// error.message, and the envelope carries the query once (the raw response
// repeats the message, with the query in it, 4-5 times). The responses below
// are the live shapes (testing_db, 2026-11-18), hosts replaced.
import { afterEach, describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { fakeFetch, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import { resetExecutableCategoryCache } from "../../lib/sql/api";
import { executeSqlReadQuery, executeSqlUpdate } from "../../lib/sql/executor";
import { describeSqlFailure, sqlDatabaseMessage } from "../../lib/sql/result";
import type { NormalizedSqlDatabase } from "../../lib/sql/types";

function failedResponse(databaseError: string) {
  const message = JSON.stringify({
    result: { message: "Unexpected error occurred. Please check with system administrator for more details.", status: 400, databaseError },
  });
  const step = { executed: false, message, failed: true, statusCode: 400, stepIndex: 1, errorMessage: message, calls: [{ category: "Database.SQL", method: "select" }] };
  return {
    services: [{ executionStatus: { ...step }, outputs: [] }],
    executionStatus: {
      executed: false,
      message,
      failed: true,
      statusCode: 400,
      executionTime: { time: 496.7, unit: "milliseconds" },
      failingSteps: [1],
      failingStepsStatuses: [step],
      totalExecutionTime: { time: 674.9, unit: "milliseconds" },
      calls: step.calls,
      errorMessage: message,
    },
  };
}

const BAD_COLUMN = 'org.postgresql.util.PSQLException: ERROR: column "category" does not exist\n  Position: 67';
const springWrapped = (query: string) =>
  `org.springframework.dao.InvalidDataAccessApiUsageException: SQL [/* Helpers.CSV:, dev.example.test:x,  */ ${query}]: given 1 parameters but expected 0`;

describe("sqlDatabaseMessage", () => {
  test("strips the exception class and ERROR:, keeps the position", () => {
    expect(sqlDatabaseMessage(BAD_COLUMN)).toBe('column "category" does not exist (position 67)');
  });
  test("strips Spring's SQL [<query>] wrapper (the query may contain ]: itself)", () => {
    expect(sqlDatabaseMessage(springWrapped("select a[1]: x from t"))).toBe("given 1 parameters but expected 0");
    expect(
      sqlDatabaseMessage(
        "org.springframework.jdbc.BadSqlGrammarException: PreparedStatementCallback; bad SQL grammar [select x from t]; nested exception is org.postgresql.util.PSQLException: ERROR: relation \"t\" does not exist",
      ),
    ).toBe('relation "t" does not exist');
  });
});

describe("describeSqlFailure", () => {
  test("the message once, the query nowhere but details.query", () => {
    const query = "select x from t where details ? 'k' /* " + "pad ".repeat(2000) + "*/";
    const raw = failedResponse(springWrapped(query));
    const f = describeSqlFailure(raw, query);
    expect(f.message).toContain("given 1 parameters but expected 0");
    expect(f.message).toContain("'??'");
    const size = JSON.stringify(f).length;
    expect(JSON.stringify(raw).length).toBeGreaterThan(4 * query.length);
    expect(size).toBeLessThan(1000);
    expect(f.error?.detail).toContain("<query>");
    expect(f.executionStatus).toMatchObject({ failed: true, statusCode: 400, failingSteps: [1] });
    expect(f.executionStatus).not.toHaveProperty("message");
  });
});

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = cfg = null;
  resetExecutableCategoryCache();
});

const DB: NormalizedSqlDatabase = { id: 215, nickname: "testing_db", source: null, host: null, port: null, authUsageType: null, derivedAuthType: null };
const CONTEXT = { operation: { id: 19, methodUUID: "abc" } as any, template: { id: 1, uuid: "abc", category: { id: 7 }, jsonDefinition: JSON.stringify({ services: [{ automationApiId: 19, mappings: [{ encodingType: "BASE_64", value: "" }] }] }) } as any };

const routes = () => [
  { method: "GET", url: /chain\/category/, response: [{ id: 7, name: "Helpers", accessMode: "PUBLIC" }] },
  { method: "POST", url: "/rest/api/automation/chain/test", response: failedResponse(BAD_COLUMN) },
];

async function failureOf(run: () => Promise<unknown>): Promise<CliError> {
  try {
    await run();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected a failure");
}

describe("executors put the database message in error.message", () => {
  test("run: SQL_QUERY_FAILED with the column error", async () => {
    cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
    ff = fakeFetch(routes()).install();
    const e = await failureOf(() => executeSqlReadQuery({ query: "select category from t", database: DB, context: CONTEXT }));
    expect(e.code).toBe("SQL_QUERY_FAILED");
    expect(e.message).toBe('SQL query execution failed: column "category" does not exist (position 67)');
    expect((e.details as any).query).toBe("select category from t");
  });

  test("update: SQL_UPDATE_QUERY_FAILED", async () => {
    cfg = withTempEnvConfig({ envs: { dev: { url: "https://dev.example.test" } }, activeEnv: "dev" });
    ff = fakeFetch(routes()).install();
    const e = await failureOf(() => executeSqlUpdate({ query: "update t set category = 1", database: DB, context: CONTEXT }));
    expect(e.code).toBe("SQL_UPDATE_QUERY_FAILED");
    expect(e.message).toContain('column "category" does not exist');
  });
});
