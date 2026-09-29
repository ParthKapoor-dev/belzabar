import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CliError, confirmWrite, logWriteIntent } from "../src";

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError");
}

const base = { outputMode: "llm" as const, action: "delete X", details: [["Method", "X"]] as Array<[string, string]>, requiredMessage: "need --yes" };

describe("confirmWrite", () => {
  test("--yes proceeds without asking", async () => {
    await confirmWrite({ ...base, yes: true });
  });

  test("--llm without --yes: prefixed code, pairs by default", async () => {
    const e = await caught(confirmWrite({ ...base, yes: false, codePrefix: "AD" }));
    expect(e.code).toBe("AD_CONFIRMATION_REQUIRED");
    expect(e.message).toBe("need --yes");
    expect(e.details).toEqual({ action: "delete X", details: [["Method", "X"]] });
  });

  test("unprefixed code and object-shaped details", async () => {
    const e = await caught(confirmWrite({ ...base, yes: false, detailsShape: "object" }));
    expect(e.code).toBe("CONFIRMATION_REQUIRED");
    expect(e.details).toEqual({ action: "delete X", details: { Method: "X" } });
  });
});

describe("logWriteIntent", () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  test("one [belz <ns> write] line; fields, then env, then meta", () => {
    const lines: string[] = [];
    spy = spyOn(process.stderr, "write").mockImplementation(((s: string) => {
      lines.push(String(s));
      return true;
    }) as typeof process.stderr.write);
    logWriteIntent("ad", { method: "POST", path: "/p" }, { n: 1 }, { withEnv: true });
    logWriteIntent("tw", { method: "POST", path: "/q" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("[belz ad write] ");
    const rec = JSON.parse(lines[0]!.slice("[belz ad write] ".length));
    expect(Object.keys(rec)).toEqual(["ts", "method", "path", "env", "n"]);
    expect(JSON.parse(lines[1]!.slice("[belz tw write] ".length))).not.toHaveProperty("env");
  });
});
