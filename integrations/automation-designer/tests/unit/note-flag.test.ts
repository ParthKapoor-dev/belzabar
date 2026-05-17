import { describe, expect, test } from "bun:test";
import { extractNoteFlag } from "../../lib/args/common";

describe("extractNoteFlag", () => {
  test("no --note — rest untouched, note undefined", () => {
    const r = extractNoteFlag(["uuid-1", "--yes"]);
    expect(r.note).toBeUndefined();
    expect(r.rest).toEqual(["uuid-1", "--yes"]);
  });

  test("--note <value> — value extracted, flag pair removed", () => {
    const r = extractNoteFlag(["uuid-1", "--note", "fixed the bug", "--yes"]);
    expect(r.note).toBe("fixed the bug");
    expect(r.rest).toEqual(["uuid-1", "--yes"]);
  });

  test("--note=value form", () => {
    const r = extractNoteFlag(["uuid-1", "--note=inline note"]);
    expect(r.note).toBe("inline note");
    expect(r.rest).toEqual(["uuid-1"]);
  });

  test("--note before the positional uuid", () => {
    const r = extractNoteFlag(["--note", "a note", "uuid-1"]);
    expect(r.note).toBe("a note");
    expect(r.rest).toEqual(["uuid-1"]);
  });

  test("note value is trimmed", () => {
    const r = extractNoteFlag(["uuid-1", "--note", "  spaced  "]);
    expect(r.note).toBe("spaced");
  });

  test("--note with no value throws", () => {
    expect(() => extractNoteFlag(["uuid-1", "--note"])).toThrow();
  });

  test("--note followed by another flag throws", () => {
    expect(() => extractNoteFlag(["uuid-1", "--note", "--yes"])).toThrow();
  });

  test("empty --note= throws", () => {
    expect(() => extractNoteFlag(["uuid-1", "--note="])).toThrow();
  });
});
