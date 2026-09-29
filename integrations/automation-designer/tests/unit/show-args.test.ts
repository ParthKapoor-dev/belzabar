// AD-14 / F6 / F34: `ad show` flags are declared, `--service-detail` works, bad input errors.
import { describe, expect, test } from "bun:test";
import command, { args } from "../../commands/show/index";
import { errorCode as codeOf } from "@belzabar/core/testing";

const parse = (argv: string[]) => command.parseArgs!(argv, {} as any) as any;
const UUID = "4bf56e0012345678901234567890abcd";

describe("ad show args", () => {
  test("--service-detail N is an alias of --step N (AD-14)", () => {
    expect(parse([UUID, "--service-detail", "2"]).flags.step).toBe(2);
    expect(parse([UUID, "--step", "3"]).flags.step).toBe(3);
    expect(parse([UUID, "--service-detail=4"]).flags.step).toBe(4);
    expect(parse([UUID]).flags.step).toBeNull();
  });

  test("missing / invalid step values error instead of being ignored", () => {
    expect(codeOf(() => parse([UUID, "--service-detail"]))).toBe("MISSING_VALUE");
    expect(codeOf(() => parse([UUID, "--step", "--full"]))).toBe("MISSING_VALUE");
    expect(codeOf(() => parse([UUID, "--step", "two"]))).toBe("INVALID_VALUE");
  });

  test("unknown flags are rejected (F34)", () => {
    expect(codeOf(() => parse([UUID, "--bogusflag"]))).toBe("UNKNOWN_FLAG");
  });

  test("missing uuid keeps MISSING_UUID", () => {
    expect(codeOf(() => parse([]))).toBe("MISSING_UUID");
  });

  test("booleans, -o and --v2", () => {
    const r = parse([UUID, "--code", "--sql", "-o", "--v2"]);
    expect(r.flags.code).toBe(true);
    expect(r.flags.sql).toBe(true);
    expect(r.flags.open).toBe(true);
    expect(r.apiVersion).toBe("v2");
    expect(args.kind).toBe("args");
  });
});
