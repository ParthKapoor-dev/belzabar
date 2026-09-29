// Guards the committed wire fixtures: nothing that looks like a credential,
// token, cookie, personal e-mail, phone number or person name may
// be checked in. Guards the whole tracked tree against real hostnames (and,
// when BELZ_SCRUB_TERMS names the local term list, against project/tenant
// names): the repo is project-agnostic. Also unit-tests the sanitizer and the
// capture tool's read-only guard.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  applyTerms,
  findHosts,
  findSecrets,
  loadScrubTerms,
  personCode,
  sanitize,
  sanitizeText,
  setScrubTerms,
  withoutBase64,
  type ScrubTerm,
} from "./sanitize";
import { assertCaptureEnv, assertReadOnly, captureEnv, CaptureRefused } from "./guard";

// The local term list (if exported) is for the tree guard below; the sanitizer
// unit tests run with a fixed, fictional list so they behave the same everywhere.
const LOCAL_TERMS = loadScrubTerms();
const TEST_TERMS: ScrubTerm[] = [[/globex/gi, "acme"], [/(?<![a-z])gx(?![a-z])/gi, "ac"]];
beforeAll(() => setScrubTerms(TEST_TERMS));
afterAll(() => setScrubTerms(LOCAL_TERMS));

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

describe("person names", () => {
  test("person records are pseudonymized deterministically; system accounts kept", () => {
    const out = sanitize({
      a: { id: 1, firstName: "Jane", lastName: "Roe", fullName: "Jane Roe", email: "n@corp.io" },
      b: { firstName: "Jane", lastName: "Roe" },
      sys: { firstName: "Admin", lastName: "ACME", fullName: "Admin ACME" },
      tw: { "first-name": "John", "last-name": "Doe" },
    }) as any;
    const code = personCode("Jane Roe");
    expect(out.a).toEqual({ id: 1, firstName: "Test", lastName: `User-${code}`, fullName: `Test User-${code}`, email: "user@example.com" });
    expect(out.b.lastName).toBe(out.a.lastName); // same person, same pseudonym
    expect(out.sys).toEqual({ firstName: "Admin", lastName: "ACME", fullName: "Admin ACME" });
    expect(out.tw["first-name"]).toBe("Test");
    expect(out.tw["last-name"]).toMatch(/^User-[0-9a-z]{4}$/);
    expect(sanitize(out)).toEqual(out); // idempotent
  });

  test("Jenkins causes and change-log notes", () => {
    const out = sanitize({
      cause: { shortDescription: "Started by user pat", userId: "pat", userName: "pat" },
      comment: "Developer: Sam Poe<br>Reveiwer: Eve<br>Dev:Val",
      html: "Developer =&gt; Rob<br>Reviewer =&gt; Ava",
    }) as any;
    expect(out.cause.userId).toMatch(/^user-[0-9a-z]{4}$/);
    expect(out.cause.shortDescription).toBe(`Started by user ${out.cause.userId}`);
    expect(out.comment).toBe(
      `Developer: person-${personCode("Sam Poe")}<br>Reveiwer: person-${personCode("Eve")}<br>Dev:person-${personCode("Val")}`,
    );
    expect(out.html).toBe(`Developer =&gt; person-${personCode("Rob")}<br>Reviewer =&gt; person-${personCode("Ava")}`);
    expect(sanitize(out)).toEqual(out);
    const consoleLine = "Started by user \x1b[8mha:////4KxvQJWtZTvBnC+PMwTW+w==\x1b[0mpat\r\nnext";
    expect(sanitizeText(consoleLine)).toBe(`Started by user user-${personCode("pat")}\r\nnext`);
    expect(findSecrets(JSON.stringify(out))).toEqual([]);
  });

  test("findSecrets flags real names left in name fields and notes", () => {
    const kinds = findSecrets(
      JSON.stringify({ firstName: "Jane", lastName: "Roe", note: "Developer: Val", userName: "pat" }),
    ).map((f) => f.kind);
    expect(kinds.filter((k) => k === "person-name").length).toBe(4);
    expect(findSecrets(JSON.stringify({ firstName: "Super", lastName: "User", fullName: "Super User" }))).toEqual([]);
  });
});

describe("capture guard", () => {
  test("only the BELZ_CAPTURE_ENV env; nothing built in", () => {
    expect(() => captureEnv("")).toThrow(CaptureRefused);
    expect(() => captureEnv(undefined)).toThrow(/BELZ_CAPTURE_ENV/);
    expect(captureEnv(" dev ")).toBe("dev");
    expect(() => assertCaptureEnv("dev", "dev")).not.toThrow();
    for (const env of ["prod", "dev2", "qa", ""]) expect(() => assertCaptureEnv(env, "dev")).toThrow(CaptureRefused);
  });
  test("only GET", () => {
    expect(() => assertReadOnly("GET")).not.toThrow();
    expect(() => assertReadOnly(undefined)).not.toThrow();
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) expect(() => assertReadOnly(m)).toThrow(CaptureRefused);
  });
});

describe("project terms + hostnames (rules 10, 11)", () => {
  test("terms are replaced case-preserving, inside JSON text too, without re-encoding it", () => {
    // mixed case keeps the replacement as written; `gx` only as a whole token
    expect(applyTerms("Globex globex GLOBEX gx-dev devgx_qa GlObEx", TEST_TERMS)).toBe("Acme acme ACME ac-dev devgx_qa acme");
    const json = '{"a":  "GLOBEX.Helpers", "b": [ "globex-dev" ]}';
    expect(sanitize({ jsonDefinition: json }).jsonDefinition).toBe('{"a":  "ACME.Helpers", "b": [ "acme-dev" ]}');
    expect(sanitize({ "GLOBEX.Key": 1 } as Record<string, number>)).toEqual({ "ACME.Key": 1 });
  });

  test("real hosts move to the reserved .example TLD; generic infrastructure hosts stay", () => {
    const out = sanitizeText("https://globex-dev.qa.vendor.cloud/x www.globex.org/y https://github.com/a/b http://example.com ssh://git.us-east-2.aws.com/r");
    expect(out).toBe("https://acme-dev.qa.vendor.example/x www.acme.example/y https://github.com/a/b http://example.com ssh://git.us-east-2.aws.example/r");
    expect(findHosts(out)).toEqual([]);
    expect(findHosts("console.info(x); ui.info; see https://a.b.cloud/x and svc.internal.corp.com")).toEqual(["a.b.cloud", "svc.internal.corp.com"]);
  });

  test("base64 runs (encoded custom code) are never edited token-wise", () => {
    const b64 = Buffer.from("console.log('globex gx');").toString("base64");
    expect(sanitize({ code: b64, text: `globex ${b64}` })).toEqual({ code: b64, text: `acme ${b64}` });
  });

  test("loadScrubTerms reads [[regex, replacement]] pairs from a local file", () => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-terms-"));
    try {
      const file = join(dir, "terms.json");
      writeFileSync(file, JSON.stringify({ terms: [["initech", "acme"]] }));
      const terms = loadScrubTerms(file);
      expect(applyTerms("Initech INITECH", terms)).toBe("Acme ACME");
      expect(loadScrubTerms("")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the whole tracked tree is project-agnostic ────────────────────────────

function trackedFiles(): string[] {
  const r = Bun.spawnSync(["git", "-C", ROOT, "ls-files", "-z"]);
  if (r.exitCode !== 0) return [];
  return new TextDecoder().decode(r.stdout).split("\0").filter(Boolean);
}

describe("tracked files name no real hosts or projects", () => {
  // This file holds deliberate host samples for the sanitizer tests above.
  const SELF = "scripts/fixtures/fixtures-secrets.test.ts";
  const files = trackedFiles().filter((f) => f !== "bun.lock" && f !== SELF && !/\.(png|jpe?g|gif|ico|woff2?)$/.test(f));

  // Outside a git checkout (e.g. an exported tree) there is nothing to list: skip.
  const inGit = files.length > 0;

  test.skipIf(!inGit)("git ls-files lists the tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test.skipIf(!inGit)("no hostname on a public TLD outside the generic allowlist (use *.example / *.test placeholders)", () => {
    const bad: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
      for (const h of findHosts(`${f}\n${text}`)) bad.push(`${f}: ${h}`);
    }
    expect(bad).toEqual([]);
  });

  // Only with the local list (BELZ_SCRUB_TERMS): the names themselves are never committed.
  test.skipIf(!inGit || LOCAL_TERMS.length === 0)("no local scrub term (project / tenant / person name) anywhere, file names included", () => {
    const bad: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
      for (const [re] of LOCAL_TERMS) {
        const n = (`${f}\n${withoutBase64(text)}`.match(re) ?? []).length;
        if (n > 0) bad.push(`${f}: /${re.source}/ ×${n}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
