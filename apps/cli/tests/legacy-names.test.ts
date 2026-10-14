// The one-time move of a pre-rename install (lib/legacy-names.ts), on scratch dirs.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { scratchDir } from "@belzabar/core/testing";
import { migrateLegacyBinary, migrateLegacyHome } from "../lib/legacy-names";

describe("migrateLegacyHome", () => {
  test("moves ~/.belz to ~/.wi-impl and leaves ~/.belz pointing at it", () => {
    const home = scratchDir("legacy-home-");
    mkdirSync(join(home, ".belz"));
    writeFileSync(join(home, ".belz", "config.json"), "{}");
    expect(migrateLegacyHome({}, home, false)).toBe(join(home, ".wi-impl"));
    expect(readFileSync(join(home, ".wi-impl", "config.json"), "utf8")).toBe("{}");
    expect(readlinkSync(join(home, ".belz"))).toBe(".wi-impl");
    expect(readFileSync(join(home, ".belz", "config.json"), "utf8")).toBe("{}"); // older binaries still find it
    expect(migrateLegacyHome({}, home, false)).toBeNull(); // once
  });

  test("Windows: moved, no link", () => {
    const home = scratchDir("legacy-home-win-");
    mkdirSync(join(home, ".belz"));
    expect(migrateLegacyHome({}, home, true)).toBe(join(home, ".wi-impl"));
    expect(existsSync(join(home, ".belz"))).toBe(false);
  });

  test("never with a chosen data dir, or when ~/.wi-impl exists, or nothing to move", () => {
    const home = scratchDir("legacy-home-skip-");
    expect(migrateLegacyHome({}, home, false)).toBeNull();
    mkdirSync(join(home, ".belz"));
    expect(migrateLegacyHome({ WI_IMPL_HOME: "/x" }, home, false)).toBeNull();
    expect(migrateLegacyHome({ BELZ_HOME: "/x" }, home, false)).toBeNull();
    mkdirSync(join(home, ".wi-impl"));
    expect(migrateLegacyHome({}, home, false)).toBeNull();
    expect(lstatSync(join(home, ".belz")).isDirectory()).toBe(true); // both kept, nothing merged
  });
});

describe("migrateLegacyBinary", () => {
  test("renames belz to wi-impl (and its .prev) and leaves a belz symlink", () => {
    const dir = scratchDir("legacy-bin-");
    writeFileSync(join(dir, "belz"), "new binary", { mode: 0o755 });
    writeFileSync(join(dir, "belz.prev"), "old binary");
    expect(migrateLegacyBinary(join(dir, "belz"), false)).toBe(join(dir, "wi-impl"));
    expect(readFileSync(join(dir, "wi-impl"), "utf8")).toBe("new binary");
    expect(readFileSync(join(dir, "wi-impl.prev"), "utf8")).toBe("old binary");
    expect(existsSync(join(dir, "belz.prev"))).toBe(false);
    expect(readlinkSync(join(dir, "belz"))).toBe("wi-impl");
    // Run again through the alias (a symlink now): nothing to do.
    expect(migrateLegacyBinary(join(dir, "belz"), false)).toBeNull();
  });

  test("Windows: wi-impl.exe plus a belz.cmd that runs it", () => {
    const dir = scratchDir("legacy-bin-win-");
    writeFileSync(join(dir, "belz.exe"), "exe");
    expect(migrateLegacyBinary(join(dir, "belz.exe"), true)).toBe(join(dir, "wi-impl.exe"));
    expect(existsSync(join(dir, "belz.exe"))).toBe(false);
    expect(readFileSync(join(dir, "belz.cmd"), "utf8")).toBe('@"%~dp0wi-impl.exe" %*\r\n');
  });

  test("leaves alone: a binary not named belz, or one installed next to wi-impl", () => {
    const dir = scratchDir("legacy-bin-skip-");
    writeFileSync(join(dir, "wi-impl"), "x");
    expect(migrateLegacyBinary(join(dir, "wi-impl"), false)).toBeNull();
    writeFileSync(join(dir, "belz"), "y");
    expect(migrateLegacyBinary(join(dir, "belz"), false)).toBeNull();
    expect(readFileSync(join(dir, "belz"), "utf8")).toBe("y");
  });
});
