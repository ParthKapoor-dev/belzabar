// `belz setup` argument parsing (core defineArgs). Parse only — setup is never run here.
import { describe, expect, test } from "bun:test";
import setup from "../commands/setup/index";

const ctx = { outputMode: "llm", env: { name: "t" }, warn: () => {} } as any;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e: any) {
    return e.code;
  }
  throw new Error("expected a throw");
}

describe("setup args", () => {
  test("setup", () => {
    expect(setup.parseArgs!(["--env-file", "x.env", "--force"], ctx)).toEqual({ force: true, fromEnv: false, envFile: "x.env", replace: false });
    expect((setup.parseArgs!(["--from-env", "--replace", "--force"], ctx) as any).replace).toBe(true);
    expect(setup.parseArgs!(["--from-env"], ctx)).toMatchObject({ force: false, fromEnv: true, envFile: undefined });
    expect(code(() => setup.parseArgs!(["--env-file"], ctx))).toBe("MISSING_VALUE");
    expect(code(() => setup.parseArgs!(["--env-file", "a", "--from-env"], ctx))).toBe("CONFLICTING_FLAGS");
    expect(code(() => setup.parseArgs!(["--bogus"], ctx))).toBe("UNKNOWN_FLAG");
  });
  test("writes local config", () => {
    expect((setup as any).writesLocal).toBe(true);
  });
});
