// Strict argument parsing for every `belz tw` command.
import { describe, expect, test } from "bun:test";
import { parseTaskId } from "../../lib/task-id";
import * as task from "../../commands/task/index";
import * as comments from "../../commands/comments/index";
import * as items from "../../commands/items/index";
import * as search from "../../commands/search/index";
import * as addComment from "../../commands/add-comment/index";
import { errorCode as code } from "@belzabar/core/testing";

describe("parseTaskId", () => {
  test("accepts ids and task URLs", () => {
    expect(parseTaskId("26917411")).toBe(26917411);
    expect(parseTaskId(" 42 ")).toBe(42);
    expect(parseTaskId("https://tw.example.test/app/tasks/26917411")).toBe(26917411);
    expect(parseTaskId("https://tw.example.test/app/tasks/26917411?c=1")).toBe(26917411);
    expect(parseTaskId("https://tw.example.test/#/tasks/123/comments")).toBe(123);
  });
  test("rejects junk", () => {
    for (const bad of ["123abc", "-5", "0", "abc", "1.5", "", "https://x/tasks/12ab"]) {
      expect(code(() => parseTaskId(bad))).toBe("INVALID_TASK_ID");
    }
  });
});

describe("task / comments / items", () => {
  for (const [name, mod] of [["task", task], ["comments", comments], ["items", items]] as const) {
    test(name, () => {
      expect(mod.parseArgs(["123"])).toEqual({ taskId: 123 });
      expect(code(() => mod.parseArgs([]))).toBe("MISSING_ARG");
      expect(code(() => mod.parseArgs(["123abc"]))).toBe("INVALID_TASK_ID");
      expect(code(() => mod.parseArgs(["-5"]))).toBe("INVALID_TASK_ID");
      expect(code(() => mod.parseArgs(["123", "--bogus"]))).toBe("UNKNOWN_FLAG");
      expect(code(() => mod.parseArgs(["123", "456"]))).toBe("UNEXPECTED_ARGUMENT");
    });
  }
});

describe("search", () => {
  test("query words, defaults, flags", () => {
    expect(search.parseArgs(["foo", "bar"])).toEqual({ query: "foo bar", limit: 25, projectId: undefined, includeCompleted: false });
    const r = search.parseArgs(["aging", "--project", "123456", "--limit", "10", "--include-completed"]);
    expect(r).toEqual({ query: "aging", limit: 10, projectId: 123456, includeCompleted: true });
  });
  test("a typo'd flag is an error, not part of the query", () => {
    expect(code(() => search.parseArgs(["foo", "--limt", "5"]))).toBe("UNKNOWN_FLAG");
  });
  test("--limit is bounded to 1..500", () => {
    expect(code(() => search.parseArgs(["a", "--limit", "1000"]))).toBe("INVALID_VALUE");
    expect(code(() => search.parseArgs(["a", "--limit", "0"]))).toBe("INVALID_VALUE");
    expect(code(() => search.parseArgs(["a", "--limit"]))).toBe("MISSING_VALUE");
    expect(search.parseArgs(["a", "--limit", "500"]).limit).toBe(500);
  });
  test("missing query", () => {
    expect(code(() => search.parseArgs([]))).toBe("MISSING_QUERY");
  });
});

describe("add-comment", () => {
  test("parses", () => {
    expect(addComment.parseArgs(["1", "--body", "hi", "-y"])).toEqual({
      taskId: 1, body: "hi", bodyFile: undefined, contentType: "TEXT", yes: true,
    });
    expect(addComment.parseArgs(["1", "--body-file=x.md", "--html"]).contentType).toBe("HTML");
  });
  test("--body --yes is MISSING_VALUE", () => {
    expect(code(() => addComment.parseArgs(["1", "--body", "--yes"]))).toBe("MISSING_VALUE");
  });
  test("body and body-file: exactly one", () => {
    expect(code(() => addComment.parseArgs(["1"]))).toBe("MISSING_FLAG");
    expect(code(() => addComment.parseArgs(["1", "--body", "a", "--body-file", "b"]))).toBe("CONFLICTING_FLAGS");
  });
  test("is a write", () => {
    expect(addComment.writes).toBe(true);
  });
});
