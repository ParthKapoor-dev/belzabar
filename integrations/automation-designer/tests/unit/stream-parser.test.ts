import { describe, expect, test } from "bun:test";
import { parseStreamText } from "../../lib/stream-parser";

describe("parseStreamText", () => {
  test("empty body", () => {
    const r = parseStreamText("");
    expect(r.chunks).toEqual([]);
    expect(r.finalFormat).toBe("text");
  });

  test("chunks followed by a final JSON envelope", () => {
    const r = parseStreamText('hello\nworld\n{"done":true,"count":2}');
    expect(r.chunks).toEqual(["hello", "world"]);
    expect(r.finalFormat).toBe("json");
    expect(r.final).toEqual({ done: true, count: 2 });
  });

  test("single JSON line — no chunks", () => {
    const r = parseStreamText('{"ok":1}');
    expect(r.chunks).toEqual([]);
    expect(r.final).toEqual({ ok: 1 });
    expect(r.finalFormat).toBe("json");
  });

  test("blank lines are dropped", () => {
    const r = parseStreamText('a\n\n\nb\n\n{"x":1}\n');
    expect(r.chunks).toEqual(["a", "b"]);
    expect(r.final).toEqual({ x: 1 });
  });

  test("CRLF line endings", () => {
    const r = parseStreamText('one\r\ntwo\r\n{"z":9}');
    expect(r.chunks).toEqual(["one", "two"]);
    expect(r.final).toEqual({ z: 9 });
  });

  test("no parseable final envelope — all text", () => {
    const r = parseStreamText("just\nplain\ntext");
    expect(r.finalFormat).toBe("text");
    expect(r.chunks).toEqual(["just", "plain", "text"]);
    expect(r.final).toBe("just\nplain\ntext");
  });
});
