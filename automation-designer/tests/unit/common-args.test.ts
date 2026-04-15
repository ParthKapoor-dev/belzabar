import { describe, expect, test, beforeEach } from "bun:test";
import {
  __resetWarnOnceForTests,
  emitFallbackWarning,
  parseAdCommonArgs,
} from "../../lib/args/common";

describe("parseAdCommonArgs", () => {
  beforeEach(() => {
    __resetWarnOnceForTests();
  });

  test("default — no --v2, no fallback", () => {
    const parsed = parseAdCommonArgs(["abc-uuid", "--code"], "fetch", "show");
    expect(parsed.rest).toEqual(["abc-uuid", "--code"]);
    expect(parsed.common.apiVersion.version).toBe("v1");
    expect(parsed.common.apiVersion.wasFallback).toBe(false);
  });

  test("strips --v2 from rest", () => {
    const parsed = parseAdCommonArgs(["abc", "--v2", "--code"], "fetch", "show");
    expect(parsed.rest).toEqual(["abc", "--code"]);
    expect(parsed.common.apiVersion.version).toBe("v2");
    expect(parsed.common.apiVersion.wasFallback).toBe(false);
    expect(parsed.common.apiVersion.requested).toBe("v2");
  });

  test("--v2 on unsupported op falls back to v1 with wasFallback=true", () => {
    const parsed = parseAdCommonArgs(["name", "--v2"], "category", "category");
    expect(parsed.rest).toEqual(["name"]);
    expect(parsed.common.apiVersion.version).toBe("v1");
    expect(parsed.common.apiVersion.wasFallback).toBe(true);
  });

  test("preserves argv order and unrelated flags", () => {
    const parsed = parseAdCommonArgs(
      ["--inputs", "file.json", "--v2", "uuid", "--raw"],
      "fetch",
      "show",
    );
    expect(parsed.rest).toEqual(["--inputs", "file.json", "uuid", "--raw"]);
  });

  test("emitFallbackWarning writes to stderr exactly once per cmd", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const parsed = parseAdCommonArgs(["--v2"], "category", "category");
      emitFallbackWarning(parsed.common, "category");
      emitFallbackWarning(parsed.common, "category");
      emitFallbackWarning(parsed.common, "category");
    } finally {
      process.stderr.write = original;
    }

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("V2 not supported");
    expect(writes[0]).toContain("belz ad category");
  });

  test("emitFallbackWarning is a no-op when not a fallback", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const parsed = parseAdCommonArgs([], "fetch", "show");
      emitFallbackWarning(parsed.common, "show");
    } finally {
      process.stderr.write = original;
    }

    expect(writes.length).toBe(0);
  });
});
