// One summary of a method's persistent test suite, shared by `ad test-cases`
// and `ad test-case list` (F24: `test-case list` returned the raw body —
// `null` when the method has no suite — while `test-cases` was structured).

export interface TestCaseRow {
  id: string;
  name: string;
  active: boolean;
  inputCount: number;
  assertionCount: number;
}

export interface TestSuiteSummary {
  uuid: string;
  testSuiteId: string | null;
  executionStatus: string | null;
  active: boolean | null;
  total: number;
  testCases: TestCaseRow[];
}

/** Summarise a `/chain/testsuite/service-chain/{uuid}` body (suite object, bare array, or null). */
export function summarizeTestSuite(uuid: string, body: unknown): TestSuiteSummary {
  const suite: Record<string, unknown> =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : { testCases: Array.isArray(body) ? body : [] };

  const cases: unknown[] = Array.isArray(suite.testCases) ? suite.testCases : [];
  const testCases: TestCaseRow[] = cases
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      id: typeof c.id === "string" ? c.id : "",
      name: typeof c.name === "string" ? c.name : "",
      active: c.active !== false,
      inputCount: Array.isArray(c.inputs) ? c.inputs.length : 0,
      assertionCount: Array.isArray(c.assertions) ? c.assertions.length : 0,
    }));

  return {
    uuid,
    testSuiteId: typeof suite.id === "string" ? suite.id : null,
    executionStatus: typeof suite.executionStatus === "string" ? suite.executionStatus : null,
    active: typeof suite.active === "boolean" ? suite.active : null,
    total: testCases.length,
    testCases,
  };
}
