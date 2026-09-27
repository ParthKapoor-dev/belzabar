import { describe, expect, test, beforeEach } from "bun:test";
import { defineArgs } from "@belzabar/core";
import {
  AD_COMMON_FLAGS,
  __resetWarnOnceForTests,
  emitFallbackWarning,
  resolveAdCommon,
} from "../../lib/args/common";
import { resolveApiVersion } from "../../lib/api-version";

describe("AD common flags", () => {
  beforeEach(() => {
    __resetWarnOnceForTests();
  });

  const def = defineArgs({ positionals: [{ name: "uuid" }], flags: { ...AD_COMMON_FLAGS, code: { type: "boolean" } } });

  test("default — no --v2, no fallback", () => {
    const { flags } = def.parse(["abc-uuid", "--code"]);
    const common = resolveAdCommon(flags, "fetch", "show");
    expect(common.apiVersion.version).toBe("v1");
    expect(common.apiVersion.wasFallback).toBe(false);
  });

  test("--v2 selects v2 where supported", () => {
    const { flags, positionals } = def.parse(["abc", "--v2", "--code"]);
    expect(positionals.uuid).toBe("abc");
    const common = resolveAdCommon(flags, "fetch", "show");
    expect(common.apiVersion.version).toBe("v2");
    expect(common.apiVersion.requested).toBe("v2");
  });

  test("--v2 on unsupported op falls back to v1 with wasFallback=true", () => {
    const original = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const common = resolveAdCommon({ v2: true }, "category", "category");
      expect(common.apiVersion.version).toBe("v1");
      expect(common.apiVersion.wasFallback).toBe(true);
    } finally {
      process.stderr.write = original;
    }
  });

  test("emitFallbackWarning writes to stderr exactly once per cmd", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const common = { apiVersion: resolveApiVersion("category", "v2") };
      emitFallbackWarning(common, "category");
      emitFallbackWarning(common, "category");
      emitFallbackWarning(common, "category");
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
      emitFallbackWarning({ apiVersion: resolveApiVersion("fetch", undefined) }, "show");
    } finally {
      process.stderr.write = original;
    }

    expect(writes.length).toBe(0);
  });
});
