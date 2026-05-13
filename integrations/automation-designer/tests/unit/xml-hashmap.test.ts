import { describe, expect, test } from "bun:test";
import { parseHashMapXml, XmlParseError } from "../../lib/xml";

describe("parseHashMapXml", () => {
  test("flat HashMap", () => {
    const xml = `<HashMap><fullName>John Doe</fullName><greeting>Hello</greeting></HashMap>`;
    const result = parseHashMapXml(xml);
    expect(result.fullName).toBe("John Doe");
    expect(result.greeting).toBe("Hello");
  });

  test("nested executionStatus block", () => {
    const xml = `
      <HashMap>
        <fullName>John Doe</fullName>
        <executionStatus>
          <executed>true</executed>
          <failed>false</failed>
          <statusCode>200</statusCode>
        </executionStatus>
      </HashMap>`;
    const result = parseHashMapXml(xml);
    expect(result.fullName).toBe("John Doe");
    const status = result.executionStatus as Record<string, unknown>;
    expect(status.executed).toBe("true");
    expect(status.failed).toBe("false");
    expect(status.statusCode).toBe("200");
  });

  test("entity decoding", () => {
    const xml = `<HashMap><note>A &amp; B &lt;tag&gt; &quot;q&quot;</note></HashMap>`;
    const result = parseHashMapXml(xml);
    expect(result.note).toBe('A & B <tag> "q"');
  });

  test("self-closing tag returns null", () => {
    const xml = `<HashMap><missing/></HashMap>`;
    const result = parseHashMapXml(xml);
    expect(result.missing).toBeNull();
  });

  test("empty tag returns empty string", () => {
    const xml = `<HashMap><note></note></HashMap>`;
    const result = parseHashMapXml(xml);
    expect(result.note).toBe("");
  });

  test("strips XML declaration and comments", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<HashMap><x>1</x></HashMap>`;
    const result = parseHashMapXml(xml);
    expect(result.x).toBe("1");
  });

  test("throws on empty input", () => {
    expect(() => parseHashMapXml("")).toThrow(XmlParseError);
    expect(() => parseHashMapXml("   ")).toThrow(XmlParseError);
  });
});
