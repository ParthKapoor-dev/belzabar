// `pd lint --summary`: large pages carry dozens of refs per warning code;
// --summary keeps the counts per code and drops the refs.
import { describe, expect, test } from "bun:test";
import { args, entityReport } from "../../commands/lint/index";
import type { ValidationIssue } from "../../lib/types/common";

const issue = (code: string, severity: "error" | "warn", path: string): ValidationIssue =>
  ({ code, severity, message: `${code} at ${path}`, path }) as ValidationIssue;

describe("pd lint --summary", () => {
  const issues = [issue("E1", "error", "a"), ...Array.from({ length: 61 }, (_, i) => issue("UNUSED_VARIABLE", "warn", `v${i}`)), issue("W2", "warn", "b")];
  const head = { name: "P", id: "p1", entityType: "PAGE" as const };

  test("counts per code, no refs; errors still in full", () => {
    const r = entityReport(head, issues, false, true);
    expect(r.warnings).toEqual({ UNUSED_VARIABLE: { count: 61 }, W2: { count: 1 } });
    expect(r.issues.map((i) => i.code)).toEqual(["E1"]);
    expect(r.warnCount).toBe(62);
    expect(entityReport(head, issues, false).warnings!.UNUSED_VARIABLE!.refs).toHaveLength(61);
  });

  test("--summary and --full are exclusive", () => {
    expect(args.parse(["p1", "--summary"]).flags.summary).toBe(true);
    expect(() => args.parse(["p1", "--summary", "--full"])).toThrow(expect.objectContaining({ code: "CONFLICTING_FLAGS" }));
  });
});
