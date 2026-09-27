// Release command argument parsing (core defineArgs) + RL-5 / TW-6 spec checks.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import matrix from "../../commands/matrix/index";
import freeze from "../../commands/freeze/index";

const ctx = { outputMode: "llm" } as any;
const dir = mkdtempSync(join(tmpdir(), "belz-release-args-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    return e.code;
  }
  throw new Error("expected a throw");
}

function spec(body: unknown): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe("release matrix / freeze args", () => {
  test("positional required; unknown flags and extra args refused", async () => {
    expect(matrix.parseArgs!(["r.json"], ctx)).toEqual({ specPath: "r.json" });
    expect(await codeOf(() => matrix.parseArgs!([], ctx))).toBe("MISSING_SPEC");
    expect(await codeOf(() => matrix.parseArgs!(["r.json", "--bogus"], ctx))).toBe("UNKNOWN_FLAG");
    expect(await codeOf(() => matrix.parseArgs!(["a.json", "b.json"], ctx))).toBe("UNEXPECTED_ARGUMENT");
    expect(freeze.parseArgs!(["may-12"], ctx)).toEqual({ name: "may-12" });
    expect(await codeOf(() => freeze.parseArgs!([], ctx))).toBe("MISSING_NAME");
  });

  test("RL-5: a ticket both included and excluded is BAD_SPEC (before any network)", async () => {
    const p = spec({ name: "r", included: [1, "https://x/app/tasks/2"], excluded: ["2"] });
    expect(await codeOf(() => matrix.execute({ specPath: p }, ctx))).toBe("BAD_SPEC");
  });

  test("TW-6: junk ticket refs are BAD_SPEC, not a later 404", async () => {
    const p = spec({ name: "r", included: ["123abc"], excluded: [] });
    expect(await codeOf(() => matrix.execute({ specPath: p }, ctx))).toBe("BAD_SPEC");
  });

  test("both mark local-only writes", () => {
    expect((matrix as any).writesLocal).toBe(true);
    expect((freeze as any).writesLocal).toBe(true);
  });
});
