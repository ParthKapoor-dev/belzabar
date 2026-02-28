import { describe, expect, test } from "bun:test";
import { parseSqlRunResult } from "../../lib/sql/result";

describe("SQL run result parser", () => {
  test("extracts rows and metadata from execution output", () => {
    const result = {
      services: [
        {
          outputs: [
            {
              code: "resp",
              testResult: [{ status: "OK" }],
            },
          ],
        },
      ],
      executionStatus: {
        failed: false,
        statusCode: 200,
        totalExecutionTime: {
          time: 111,
          unit: "milliseconds",
        },
      },
    };

    const parsed = parseSqlRunResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.rowCount).toBe(1);
    expect(parsed.rows[0]).toEqual({ status: "OK" });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.executionTime?.time).toBe(111);
  });

  test("uses rowsCount style output when rows are absent", () => {
    const result = {
      services: [
        {
          outputs: [
            {
              code: "rowsCount",
              testResult: 5,
            },
          ],
        },
      ],
      executionStatus: {
        failed: false,
      },
    };

    const parsed = parseSqlRunResult(result);
    expect(parsed.rowCount).toBe(5);
    expect(parsed.rows.length).toBe(0);
  });

  test("marks failures from execution status", () => {
    const result = {
      services: [],
      executionStatus: {
        failed: true,
        statusCode: 400,
      },
    };

    const parsed = parseSqlRunResult(result);
    expect(parsed.success).toBe(false);
    expect(parsed.statusCode).toBe(400);
  });
});
