// Release command argument parsing (core defineArgs) and ticket-ref spec checks.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import matrix from "../../commands/matrix/index";
import freeze from "../../commands/freeze/index";
import { errorCode as code, rejectionCode } from "@belzabar/core/testing";

const ctx = { outputMode: "llm" } as any;
const dir = mkdtempSync(join(tmpdir(), "wi-impl-release-args-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function spec(body: unknown): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe("release matrix / freeze args", () => {
  test("positional required; unknown flags and extra args refused", async () => {
    expect(matrix.parseArgs!(["r.json"], ctx)).toEqual({ specPath: "r.json" });
    expect(code(() => matrix.parseArgs!([], ctx))).toBe("MISSING_SPEC");
    expect(code(() => matrix.parseArgs!(["r.json", "--bogus"], ctx))).toBe("UNKNOWN_FLAG");
    expect(code(() => matrix.parseArgs!(["a.json", "b.json"], ctx))).toBe("UNEXPECTED_ARGUMENT");
    expect(freeze.parseArgs!(["may-12"], ctx)).toEqual({ name: "may-12", force: false });
    expect(freeze.parseArgs!(["may-12", "--force"], ctx)).toEqual({ name: "may-12", force: true });
    expect(code(() => freeze.parseArgs!([], ctx))).toBe("MISSING_NAME");
  });

  test("a ticket both included and excluded is BAD_SPEC (before any network)", async () => {
    const p = spec({ name: "r", included: [1, "https://x/app/tasks/2"], excluded: ["2"] });
    expect(await rejectionCode(Promise.resolve(matrix.execute({ specPath: p }, ctx)))).toBe("BAD_SPEC");
  });

  test("junk ticket refs are BAD_SPEC, not a later 404", async () => {
    const p = spec({ name: "r", included: ["123abc"], excluded: [] });
    expect(await rejectionCode(Promise.resolve(matrix.execute({ specPath: p }, ctx)))).toBe("BAD_SPEC");
  });

  test("both mark local-only writes", () => {
    expect((matrix as any).writesLocal).toBe(true);
    expect((freeze as any).writesLocal).toBe(true);
  });
});
