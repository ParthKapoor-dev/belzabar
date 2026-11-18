// E3: the server reads a lone `?` and `:name` as bind parameters (Spring
// NamedParameterJdbcTemplate) and fails with "given 1 parameters but expected
// 0" / "No value registered for key '6'". They are refused before sending,
// with the escapes proven live: `??` for the jsonb operators, `[1: 6]` for slices.
import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { errorCode as code } from "@belzabar/core/testing";
import sqlCommand from "../../commands/sql";
import { findParameterMarker } from "../../lib/sql/read-only";

const parse = (argv: string[]) => sqlCommand.parseArgs!(argv, {} as any) as any;

describe("findParameterMarker", () => {
  const MARKED: Array<[string, string]> = [
    ["select * from t where details ? 'k'", "?"],
    ["select details ?| array['a'] from t", "?"],
    ["select details ?& array['a'] from t", "?"],
    ["select (arr)[1:6] from t", ":6"],
    ["select :name", ":name"],
    ["select $$ ? $$", "?"], // the server's parser does not skip dollar quotes
  ];
  for (const [sql, marker] of MARKED) {
    test(`finds ${marker} in ${JSON.stringify(sql)}`, () => expect(findParameterMarker(sql)?.marker).toBe(marker));
  }
  const CLEAN = [
    "select * from t where details ?? 'k'",
    "select details ??| array['a'] from t",
    "select (arr)[1: 6] from t",
    "select (arr)[1\\:6] from t",
    "select now()::date, x::text from t",
    "select '?' as q, ':x' as c, \"a?b\" from t",
    "select 1 -- why?\n",
    "select 1 /* :x ? */",
    "select f(a := 2)",
    "select a[1:] from t", // `:]`: ']' is a separator
  ];
  for (const sql of CLEAN) {
    test(`clean: ${JSON.stringify(sql)}`, () => expect(findParameterMarker(sql)).toBeUndefined());
  }
});

describe("refused before sending, with the hint", () => {
  test("run / explain / update / insert", () => {
    for (const argv of [
      ["run", "select * from t where details ? 'k'"],
      ["run", "select (arr)[1:6] from t"],
      ["explain", "select * from t where details ? 'k'"],
      ["update", "update t set a = 1 where details ? 'k'", "--yes"],
      ["insert", "insert into t select * from s where details ? 'k'", "--yes"],
    ]) {
      expect(code(() => parse(argv))).toBe("SQL_PARAMETER_MARKER");
    }
    let message = "";
    try {
      parse(["run", "select * from t where details ? 'k'"]);
    } catch (e) {
      message = (e as CliError).message;
    }
    expect(message).toContain("'??'");
    expect(message).toContain("arr[1: 6]");
  });

  test("the escapes pass", () => {
    expect(parse(["run", "select * from t where details ?? 'k'"]).action).toBe("run");
    expect(parse(["update", "update t set a = arr[1: 2] where details ?? 'k'", "--yes"]).action).toBe("update");
  });
});
