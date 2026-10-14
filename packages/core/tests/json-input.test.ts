import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CliError, readJsonInput, readJsonInputSync, type JsonInputErrors } from "../src";

const dir = mkdtempSync(join(tmpdir(), "wi-impl-json-input-"));
const good = join(dir, "good.json");
const bad = join(dir, "bad.json");
writeFileSync(good, '{"a":1}');
writeFileSync(bad, "{nope");

const errors: JsonInputErrors = {
  unreadable: (_e, missing) => new CliError("cannot read", { code: missing ? "X_MISSING" : "X_UNREADABLE" }),
  invalid: () => new CliError("not json", { code: "X_INVALID" }),
};

describe("readJsonInput", () => {
  test("parses, and maps missing / invalid to the caller's errors", async () => {
    expect(await readJsonInput(good, errors)).toEqual({ a: 1 });
    await expect(readJsonInput(join(dir, "none.json"), errors)).rejects.toMatchObject({ code: "X_MISSING" });
    await expect(readJsonInput(bad, errors)).rejects.toMatchObject({ code: "X_INVALID" });
    await expect(readJsonInput(dir, errors)).rejects.toMatchObject({ code: "X_UNREADABLE" });
  });

  test("sync variant", () => {
    expect(readJsonInputSync(good, errors)).toEqual({ a: 1 });
    expect(() => readJsonInputSync(bad, errors)).toThrow("not json");
  });
});
