// Tiny XML HashMap reader for V2 `test/execute` responses.
//
// V2 test-execute returns:
//   <HashMap>
//     <fullName>John Doe</fullName>
//     <executionStatus>
//       <executed>true</executed>
//       <failed>false</failed>
//       <statusCode>200</statusCode>
//     </executionStatus>
//   </HashMap>
//
// This parser handles exactly that shape: a root element with zero or more
// named children that are either text nodes or nested elements. It is NOT a
// full XML parser. If the real V2 response ever grows attributes or mixed
// content we should drop in fast-xml-parser instead.
//
// Supported:
//   - <tag>text</tag>          → { tag: "text" }
//   - <tag><child>x</child></tag>  → { tag: { child: "x" } }
//   - <tag></tag>              → { tag: "" }
//   - <tag/>                   → { tag: null }
//   - Entity decoding: &amp; &lt; &gt; &quot; &apos;
//   - Repeated tags collapse to arrays.
//
// Not supported:
//   - Attributes on elements (they are silently ignored)
//   - CDATA sections
//   - Comments, processing instructions

export interface ParsedXmlNode {
  [key: string]: string | null | ParsedXmlNode | (string | null | ParsedXmlNode)[];
}

export class XmlParseError extends Error {
  constructor(message: string, public readonly position?: number) {
    super(message);
    this.name = "XmlParseError";
  }
}

export function parseHashMapXml(xml: string): ParsedXmlNode {
  const stripped = stripDeclarationAndComments(xml).trim();
  if (!stripped) {
    throw new XmlParseError("Empty XML input");
  }

  const parser = new Parser(stripped);
  const root = parser.readElement();
  if (!root) throw new XmlParseError("No root element found");
  return (root.children ?? {}) as ParsedXmlNode;
}

// ─── Implementation ────────────────────────────────────────────────────

function stripDeclarationAndComments(input: string): string {
  let out = input;
  out = out.replace(/<\?xml[^?]*\?>/g, "");
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  return out;
}

interface Element {
  name: string;
  children: ParsedXmlNode | null;
  text: string | null;
}

class Parser {
  private pos = 0;
  constructor(private readonly input: string) {}

  readElement(): Element | null {
    this.skipWhitespace();
    if (this.pos >= this.input.length) return null;
    if (this.input[this.pos] !== "<") {
      throw new XmlParseError(`Expected '<' at position ${this.pos}`, this.pos);
    }
    this.pos++;

    // Read tag name up to '>', ' ', or '/'
    const nameStart = this.pos;
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos]!;
      if (ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
      this.pos++;
    }
    const name = this.input.slice(nameStart, this.pos);
    if (!name) throw new XmlParseError(`Empty tag at ${this.pos}`, this.pos);

    // Skip any attributes (space up to '>' or '/>')
    while (this.pos < this.input.length && this.input[this.pos] !== ">" && !(this.input[this.pos] === "/" && this.input[this.pos + 1] === ">")) {
      this.pos++;
    }

    // Self-closing?
    if (this.input[this.pos] === "/" && this.input[this.pos + 1] === ">") {
      this.pos += 2;
      return { name, children: null, text: null };
    }
    if (this.input[this.pos] !== ">") {
      throw new XmlParseError(`Unexpected char '${this.input[this.pos]}' at ${this.pos}`, this.pos);
    }
    this.pos++; // skip '>'

    // Now read children until we see </name>
    const closeMarker = `</${name}>`;
    const children: ParsedXmlNode = {};
    let text = "";
    let sawChildElement = false;

    while (this.pos < this.input.length) {
      if (this.input.startsWith(closeMarker, this.pos)) {
        this.pos += closeMarker.length;
        break;
      }
      if (this.input[this.pos] === "<") {
        // Nested element
        const child = this.readElement();
        if (!child) break;
        sawChildElement = true;
        addChild(children, child);
      } else {
        text += this.input[this.pos];
        this.pos++;
      }
    }

    if (sawChildElement) {
      return { name, children, text: null };
    }
    return { name, children: null, text: decodeEntities(text) };
  }

  private skipWhitespace() {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos]!;
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return;
      this.pos++;
    }
  }
}

function addChild(bag: ParsedXmlNode, child: Element) {
  const value = child.children != null ? child.children : child.text;
  const existing = bag[child.name];
  if (existing === undefined) {
    bag[child.name] = value as ParsedXmlNode[string];
  } else if (Array.isArray(existing)) {
    existing.push(value as any);
  } else {
    bag[child.name] = [existing as any, value as any] as any;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
