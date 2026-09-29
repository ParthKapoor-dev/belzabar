// `belz ad validate <uuid|file>`: read-only runner over lib/validate.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fakeFetch, runCommand, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import validateCommand, { args } from "../../commands/validate/index";
import { caseBody, golden, realV2 } from "./validate-fixtures";

let cfg: TempEnvConfig | undefined;
let ff: FakeFetch | undefined;
afterEach(() => {
  ff?.restore();
  cfg?.restore();
  ff = cfg = undefined;
});

const dir = mkdtempSync(join(tmpdir(), "belz-validate-"));
const file = (name: string, body: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
};
const env = () => {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
};

describe("ad validate", () => {
  test("clean file → ok, warnings listed, layers L1-L3, no network", async () => {
    env();
    ff = fakeFetch({}).install();
    const r = await runCommand(validateCommand, [file("golden.v2.json", golden())], { env: "t-dev" });
    expect(r.exitCode).toBe(0);
    const d = r.envelope!.data as any;
    expect(d).toMatchObject({ valid: true, counts: { errors: 0, warnings: 1 }, layersRun: ["L1", "L2", "L3"], source: { kind: "file" } });
    expect(ff.requests).toEqual([]);
  });

  test("errors → AD_VALIDATION_FAILED, exit 1, findings in data and details", async () => {
    env();
    ff = fakeFetch({}).install();
    const r = await runCommand(validateCommand, [file("bad.json", caseBody("v2_spel_nested"))], { env: "t-dev" });
    expect(r.exitCode).toBe(1);
    expect(r.envelope!.ok).toBe(false);
    expect(r.envelope!.error!.code).toBe("AD_VALIDATION_FAILED");
    const d = r.envelope!.data as any;
    expect(d.errors.map((e: any) => e.rule)).toEqual(["AD-SPEL-002"]);
    expect((r.envelope!.error!.details as any).errors[0].path).toBe("steps[0].inputs[0].value");
  });

  test("--strict turns warnings into errors", async () => {
    env();
    ff = fakeFetch({}).install();
    const r = await runCommand(validateCommand, [file("golden2.json", golden()), "--strict"], { env: "t-dev" });
    expect(r.envelope!.error!.code).toBe("AD_VALIDATION_FAILED");
    expect((r.envelope!.data as any).errors.map((e: any) => e.rule)).toEqual(["AD-SQL-004"]);
  });

  test("uuid (any spelling) fetches the V2 body; a PUBLISHED record is audited without AD-META-001", async () => {
    env();
    const pub = realV2().find((f) => f.file.startsWith("4f6331f1"))!.body;
    const uuid = String(pub.uuid).trim();
    ff = fakeFetch({ [`GET /rest/api/automation/chain/v2/${uuid}?basicInfo=false`]: pub }).install();
    const r = await runCommand(validateCommand, [uuid.toUpperCase()], { env: "t-dev" });
    const d = r.envelope!.data as any;
    expect(d.state).toBe("PUBLISHED");
    expect(d.errors.map((e: any) => e.rule)).not.toContain("AD-META-001");
    expect(d.notes[0]).toContain("AD-META-001");
  });

  test("an existing record's legacy spaced name is a warning; the same body as a file (a new body) is an error", async () => {
    env();
    const real = realV2().find((f) => f.file.startsWith("48eb3b02"))!.body; // "Copy of email.send", DRAFT
    const uuid = String(real.uuid).trim();
    ff = fakeFetch({ [`GET /rest/api/automation/chain/v2/${uuid}?basicInfo=false`]: real }).install();
    const r = await runCommand(validateCommand, [uuid], { env: "t-dev" });
    expect(r.envelope!.ok).toBe(true);
    const d = r.envelope!.data as any;
    expect(d.errors).toEqual([]);
    expect(d.warnings.find((w: any) => w.rule === "M1")?.message).toContain("refuses it on create and rename");
    const asFile = await runCommand(validateCommand, [file("spaced.json", real)], { env: "t-dev" });
    expect((asFile.envelope!.data as any).errors.map((e: any) => e.rule)).toContain("M1");
  });

  test("unreadable / invalid JSON file → typed errors", async () => {
    env();
    const missing = await runCommand(validateCommand, [join(dir, "nope.json")], { env: "t-dev" });
    expect(missing.envelope!.error!.code).toBe("FILE_NOT_FOUND");
    const p = join(dir, "broken.json");
    writeFileSync(p, "{");
    const broken = await runCommand(validateCommand, [p], { env: "t-dev" });
    expect(broken.envelope!.error!.code).toBe("INVALID_JSON");
  });

  test("--dry-run-compile implies --online and counts as a write (explicit --env)", () => {
    const parsed = validateCommand.parseArgs!(["./m.json", "--dry-run-compile"], {} as never) as any;
    expect(parsed).toMatchObject({ online: true, dryRunCompile: true, kind: "file" });
    expect((validateCommand.writes as (a: unknown) => boolean)(parsed)).toBe(true);
    expect((validateCommand.writes as (a: unknown) => boolean)({ ...parsed, dryRunCompile: false })).toBe(false);
    expect(args.kind).toBe("args");
  });
});
