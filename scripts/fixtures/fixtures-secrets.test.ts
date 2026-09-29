// Guards the committed wire fixtures: nothing that looks like a credential,
// token, cookie, personal e-mail, phone number or person name (CORE-R13) may
// be checked in. Also unit-
// tests the sanitizer and the capture tool's read-only guard.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { findSecrets, personCode, sanitize, sanitizeText } from "./sanitize";
import { assertCaptureEnv, assertReadOnly, CaptureRefused } from "./guard";

const ROOT = resolve(import.meta.dir, "../..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", ".next", ".claude", "agents", "dist"]);

/** Every directory named `fixtures` (or `ad-validation-samples`) under integrations/, apps/, scripts/, packages/. */
function fixtureDirs(): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.name === "fixtures") out.push(p);
      else visit(p);
    }
  };
  for (const top of ["integrations", "apps", "scripts", "packages"]) {
    try { if (statSync(join(ROOT, top)).isDirectory()) visit(join(ROOT, top)); } catch {}
  }
  return out;
}

function filesUnder(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(d, e.name)) : /\.(json|txt|xml|html|log)$/.test(e.name) ? [join(d, e.name)] : [],
  );
}

describe("committed fixtures contain no secrets / PII", () => {
  const dirs = fixtureDirs();

  test("fixture dirs are discovered", () => {
    expect(dirs.length).toBeGreaterThan(3);
  });

  for (const dir of dirs) {
    test(dir.slice(ROOT.length + 1), () => {
      const bad: string[] = [];
      for (const f of filesUnder(dir)) {
        for (const hit of findSecrets(readFileSync(f, "utf8"))) bad.push(`${f.slice(dir.length + 1)}: ${hit.kind} ${hit.match}`);
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("sanitize()", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

  test("redacts secret keys, tokens, cookies, emails, phones; keeps structure", () => {
    const out = sanitize({
      password: "hunter2",
      nested: { token: "abc", Authorization: `Bearer ${jwt}`, keep: 5, empty: "" },
      text: `call (212) 555-1234 or mail jane.doe@corp.io; cookie tw-auth=abcdef0123456789`,
      list: [{ fieldName: "host", fieldValue: "db.internal", securedField: false }, { fieldName: "username", fieldValue: "x==", securedField: true }],
      hdr: { key: "X-Api-Key", value: "s3cr3t" },
      harmless: { name: "url", value: "https://example.com/a" },
      ids: "4440a1a4628001dfb1b79aaec9dd55fe 2026-09-27 1723548015181",
    });
    expect(out).toEqual({
      password: "REDACTED",
      nested: { token: "REDACTED", Authorization: "REDACTED", keep: 5, empty: "" },
      text: "call 555-555-0100 or mail user@example.com; cookie tw-auth=REDACTED",
      list: [{ fieldName: "host", fieldValue: "REDACTED", securedField: false }, { fieldName: "username", fieldValue: "REDACTED", securedField: true }],
      hdr: { key: "X-Api-Key", value: "REDACTED" },
      harmless: { name: "url", value: "https://example.com/a" },
      ids: "4440a1a4628001dfb1b79aaec9dd55fe 2026-09-27 1723548015181",
    });
    expect(sanitizeText(`Authorization: Bearer ${jwt}`)).toBe("Authorization: Bearer REDACTED_JWT");
  });

  test("JSON-in-string is only re-encoded when something inside was redacted", () => {
    const untouched = '{"a": 1,  "b": [ "x" ]}';
    expect(sanitize({ configuration: untouched }).configuration).toBe(untouched);
    const dirty = '{"a": 1, "mail": "bob@corp.io"}';
    expect(sanitize({ configuration: dirty }).configuration).toBe('{"a":1,"mail":"user@example.com"}');
  });

  test("is idempotent and findSecrets is clean on its output", () => {
    const once = sanitize({ s: `jane@corp.io Bearer ${jwt}`, password: "p" });
    expect(sanitize(once)).toEqual(once);
    expect(findSecrets(JSON.stringify(once))).toEqual([]);
    expect(findSecrets(JSON.stringify({ s: "jane@corp.io", password: "p" })).map((f) => f.kind).sort()).toEqual(["email", "secret-key"]);
  });
});

describe("person names (CORE-R13)", () => {
  test("person records are pseudonymized deterministically; system accounts kept", () => {
    const out = sanitize({
      a: { id: 1, firstName: "Narender", lastName: "Mann", fullName: "Narender Mann", email: "n@corp.io" },
      b: { firstName: "Narender", lastName: "Mann" },
      sys: { firstName: "Admin", lastName: "SEMS", fullName: "Admin SEMS" },
      tw: { "first-name": "Kartik", "last-name": "Jaiswal" },
    }) as any;
    const code = personCode("Narender Mann");
    expect(out.a).toEqual({ id: 1, firstName: "Test", lastName: `User-${code}`, fullName: `Test User-${code}`, email: "user@example.com" });
    expect(out.b.lastName).toBe(out.a.lastName); // same person, same pseudonym
    expect(out.sys).toEqual({ firstName: "Admin", lastName: "SEMS", fullName: "Admin SEMS" });
    expect(out.tw["first-name"]).toBe("Test");
    expect(out.tw["last-name"]).toMatch(/^User-[0-9a-z]{4}$/);
    expect(sanitize(out)).toEqual(out); // idempotent
  });

  test("Jenkins causes and change-log notes", () => {
    const out = sanitize({
      cause: { shortDescription: "Started by user praveen", userId: "praveen", userName: "praveen" },
      comment: "Developer: Siva Medasani<br>Reveiwer: Ekta<br>Dev:Vandana",
      html: "Developer =&gt; Ritik<br>Reviewer =&gt; Avani",
    }) as any;
    expect(out.cause.userId).toMatch(/^user-[0-9a-z]{4}$/);
    expect(out.cause.shortDescription).toBe(`Started by user ${out.cause.userId}`);
    expect(out.comment).toBe(
      `Developer: person-${personCode("Siva Medasani")}<br>Reveiwer: person-${personCode("Ekta")}<br>Dev:person-${personCode("Vandana")}`,
    );
    expect(out.html).toBe(`Developer =&gt; person-${personCode("Ritik")}<br>Reviewer =&gt; person-${personCode("Avani")}`);
    expect(sanitize(out)).toEqual(out);
    const consoleLine = "Started by user \x1b[8mha:////4KxvQJWtZTvBnC+PMwTW+w==\x1b[0mpraveen\r\nnext";
    expect(sanitizeText(consoleLine)).toBe(`Started by user user-${personCode("praveen")}\r\nnext`);
    expect(findSecrets(JSON.stringify(out))).toEqual([]);
  });

  test("findSecrets flags real names left in name fields and notes", () => {
    const kinds = findSecrets(
      JSON.stringify({ firstName: "Narender", lastName: "Mann", note: "Developer: Vandana", userName: "praveen" }),
    ).map((f) => f.kind);
    expect(kinds.filter((k) => k === "person-name").length).toBe(4);
    expect(findSecrets(JSON.stringify({ firstName: "Super", lastName: "User", fullName: "Super User" }))).toEqual([]);
  });
});

describe("capture guard", () => {
  test("only sems-dev", () => {
    expect(() => assertCaptureEnv("sems-dev")).not.toThrow();
    for (const env of ["nsm-dev", "sems-prod", "sems-qa", ""]) expect(() => assertCaptureEnv(env)).toThrow(CaptureRefused);
  });
  test("only GET", () => {
    expect(() => assertReadOnly("GET")).not.toThrow();
    expect(() => assertReadOnly(undefined)).not.toThrow();
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(() => assertReadOnly(m)).toThrow(CaptureRefused);
  });
});
