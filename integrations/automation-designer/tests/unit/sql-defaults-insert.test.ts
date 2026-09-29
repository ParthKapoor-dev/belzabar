// AD-36 / F26: per-env default SQL database (`environments.<env>.sqlDefaultDb`).
// F25: `sql insert … RETURNING` returns the generated values. Wire shapes
// below are from live acme-dev probes on belz_tst_s4b_t1 (testing_db):
//   single row + RETURNING id → outputs [{88: "1"}, {89: "6"}]
//   multi row  + RETURNING id → step failed "…contains multiple keys: [{id=17}, {id=18}]"
//                               (rows committed)
// s3-review major: `sql tui` is a write (explicit --env).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { withTempEnvConfig, type TempEnvConfig } from "@belzabar/core/testing";
import sqlCommand from "../../commands/sql/index";
import { hasReturningClause, sqlDefaultDb, withGeneratedIdOutput } from "../../lib/sql/executor";
import { insertOutputIds, parseMultipleKeysError, parseSqlInsertResult } from "../../lib/sql/result";
import { resolveSqlDatabase } from "../../lib/sql/selector";
import type { NormalizedSqlDatabase } from "../../lib/sql/types";

// The insert operation's outputs as acme-dev serves them (trimmed).
const INSERT_OP = {
  id: 58,
  automationAPIOutputs: [
    { id: 88, consumes: "rowsImpacted", displayName: "impactedRowsCount" },
    { id: 89, consumes: "generatedId", displayName: "generatedID" },
    { id: 714, consumes: "uuid", displayName: "generatedUUID" },
    { id: 12542, consumes: "generatedKeyColumns", displayName: "generatedKeyColumns" },
  ],
};

let cfg: TempEnvConfig | null = null;
const prevEnv = process.env.BELZ_SQL_DEFAULT_DB;
afterEach(() => {
  cfg?.restore();
  cfg = null;
  if (prevEnv === undefined) delete process.env.BELZ_SQL_DEFAULT_DB;
  else process.env.BELZ_SQL_DEFAULT_DB = prevEnv;
});

function configWithSqlDefault(value: string | undefined) {
  cfg = withTempEnvConfig({ envs: { "acme-x": { url: "https://s.test" }, "orb-x": { url: "https://n.test" } }, activeEnv: "acme-x" });
  const json = JSON.parse(readFileSync(cfg.configPath, "utf8"));
  if (value !== undefined) json.environments["acme-x"].sqlDefaultDb = value;
  writeFileSync(cfg.configPath, JSON.stringify(json));
}

const dbs: NormalizedSqlDatabase[] = [
  { id: 215, nickname: "testing_db", source: null, host: null, port: null, authUsageType: null, derivedAuthType: null },
  { id: 2, nickname: "ZCPS-RDS", source: null, host: null, port: null, authUsageType: null, derivedAuthType: null },
];

describe("per-env SQL default DB (AD-36 / F26)", () => {
  test("config environments.<env>.sqlDefaultDb wins over BELZ_SQL_DEFAULT_DB, per env", () => {
    configWithSqlDefault("testing_db");
    process.env.BELZ_SQL_DEFAULT_DB = "ZCPS-RDS";
    expect(sqlDefaultDb("acme-x")).toEqual({ value: "testing_db", source: "config" });
    expect(sqlDefaultDb("orb-x")).toEqual({ value: "ZCPS-RDS", source: "env" });
    delete process.env.BELZ_SQL_DEFAULT_DB;
    expect(sqlDefaultDb("orb-x")).toBeUndefined();
  });

  test("resolution reports selectedBy config; a missing configured db is an error, not a silent fallback", () => {
    const r = resolveSqlDatabase(dbs, { envDefault: "testing_db", envDefaultSource: "config", fallbackNickname: "ORB_Read_DB" });
    expect(r.selectedBy).toBe("config");
    expect(r.selected.id).toBe(215);
    expect(() => resolveSqlDatabase(dbs, { envDefault: "nope", envDefaultSource: "config", fallbackNickname: "ORB_Read_DB" })).toThrow(
      /sqlDefaultDb 'nope' not found/,
    );
  });

  test("no default on a non-ORB env: the error names --db and the config key", () => {
    expect(() => resolveSqlDatabase(dbs, { fallbackNickname: "ORB_Read_DB" })).toThrow(/sqlDefaultDb/);
  });
});

describe("sql insert … RETURNING (F25)", () => {
  test("hasReturningClause ignores literals and comments", () => {
    expect(hasReturningClause("INSERT INTO t (a) VALUES (1) RETURNING id")).toBe(true);
    expect(hasReturningClause("insert into t (a) values ('returning')")).toBe(false);
    expect(hasReturningClause("insert into t (a) values (1) -- returning id")).toBe(false);
  });

  test("withGeneratedIdOutput adds the generatedId output (89) to the target step once", () => {
    const inner = { services: [{ automationApiId: 58, outputs: [{ automationAPIOutputId: 88, code: "resp" }] }] };
    const payload = { jsonDefinition: JSON.stringify(inner) } as any;
    const once = withGeneratedIdOutput(payload, INSERT_OP);
    const twice = withGeneratedIdOutput(once, INSERT_OP);
    const outs = JSON.parse(twice.jsonDefinition).services[0].outputs.map((o: any) => o.automationAPIOutputId);
    expect(outs).toEqual([88, 89]);
  });

  test("single-row wire: rows from 88, generated value from 89 (a numeric id is not mistaken for a row count)", () => {
    const wire = {
      executionStatus: { failed: false, statusCode: 200 },
      services: [{ outputs: [{ automationAPIOutputId: 88, testResult: "1" }, { automationAPIOutputId: 89, testResult: "6" }] }],
    };
    const p = parseSqlInsertResult(wire, insertOutputIds(INSERT_OP));
    expect(p.rowsAffected).toBe(1);
    expect(p.generatedValues).toEqual(["6"]);
  });

  test("multi-row getKey error lists the committed keys", () => {
    const msg =
      "DB execution failed: The getKey method should only be used when a single key is returned. The current key entry contains multiple keys: [{id=17}, {id=18}]";
    expect(parseMultipleKeysError(msg)).toEqual([{ id: "17" }, { id: "18" }]);
    expect(parseMultipleKeysError("contains multiple keys: [{id=5, name=e}]")).toEqual([{ id: "5", name: "e" }]);
    expect(parseMultipleKeysError("some other failure")).toBeNull();
  });
});

describe("sql tui is a write (s3-review major)", () => {
  test("writes() is true for tui, update/insert/modify; false for run/dbs", () => {
    const w = (sqlCommand as any).writes as (a: any) => boolean;
    expect(w({ action: "tui" })).toBe(true);
    expect(w({ action: "insert" })).toBe(true);
    expect(w({ action: "run" })).toBe(false);
    expect(w({ action: "dbs" })).toBe(false);
  });
});
