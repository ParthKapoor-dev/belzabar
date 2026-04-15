import { describe, expect, test } from "bun:test";
import {
  DEFAULT_VERSION,
  SUPPORTED_VERSIONS,
  UnsupportedVersionError,
  resolveApiVersion,
  type AdOperation,
} from "../../lib/api-version";

describe("resolveApiVersion", () => {
  test("uses DEFAULT_VERSION when no explicit request", () => {
    const ops = Object.keys(DEFAULT_VERSION) as AdOperation[];
    for (const op of ops) {
      const resolved = resolveApiVersion(op, undefined);
      expect(resolved.version).toBe(DEFAULT_VERSION[op]);
      expect(resolved.wasFallback).toBe(false);
      expect(resolved.requested).toBe(DEFAULT_VERSION[op]);
    }
  });

  test("returns explicit v1 when supported", () => {
    const ops = Object.keys(DEFAULT_VERSION) as AdOperation[];
    for (const op of ops) {
      const resolved = resolveApiVersion(op, "v1");
      expect(resolved.version).toBe("v1");
      expect(resolved.wasFallback).toBe(false);
      expect(resolved.requested).toBe("v1");
    }
  });

  test("returns v2 for operations that support it", () => {
    for (const op of Object.keys(SUPPORTED_VERSIONS) as AdOperation[]) {
      if (!SUPPORTED_VERSIONS[op].includes("v2")) continue;
      const resolved = resolveApiVersion(op, "v2");
      expect(resolved.version).toBe("v2");
      expect(resolved.wasFallback).toBe(false);
      expect(resolved.requested).toBe("v2");
    }
  });

  test("falls back to default when v2 is requested on unsupported op", () => {
    for (const op of Object.keys(SUPPORTED_VERSIONS) as AdOperation[]) {
      if (SUPPORTED_VERSIONS[op].includes("v2")) continue;
      const resolved = resolveApiVersion(op, "v2");
      expect(resolved.version).toBe(DEFAULT_VERSION[op]);
      expect(resolved.wasFallback).toBe(true);
      expect(resolved.requested).toBe("v2");
    }
  });

  test("fetch and test currently support v2", () => {
    expect(SUPPORTED_VERSIONS.fetch).toContain("v2");
    expect(SUPPORTED_VERSIONS.test).toContain("v2");
  });

  test("DEFAULT_VERSION[op] is always in SUPPORTED_VERSIONS[op]", () => {
    for (const op of Object.keys(DEFAULT_VERSION) as AdOperation[]) {
      expect(SUPPORTED_VERSIONS[op]).toContain(DEFAULT_VERSION[op]);
    }
  });

  test("UnsupportedVersionError carries op and requested", () => {
    const err = new UnsupportedVersionError("save", "v2");
    expect(err.op).toBe("save");
    expect(err.requested).toBe("v2");
    expect(err.name).toBe("UnsupportedVersionError");
  });
});
