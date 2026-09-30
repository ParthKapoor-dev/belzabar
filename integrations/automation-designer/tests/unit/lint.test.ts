// `belz ad lint` — lib/validate/lint.ts review rules (positive + negative
// per rule, on the research golden method), calibration over the 36 real
// acme-dev bodies, and the command (grouping, exit code) via fakeFetch.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { reloadConfig } from "@belzabar/core";
import { join } from "path";
import { fakeFetch, fixture, runCommand, scratchDir, withTempEnvConfig, type FakeFetch, type TempEnvConfig } from "@belzabar/core/testing";
import lintCommand, { groupFindings } from "../../commands/lint/index";
import validateCommand from "../../commands/validate/index";
import { isCompactSpec } from "../../lib/save/spec";
import { isJsonJuggling, lintMethodV2, LINT_RULES } from "../../lib/validate/lint";
import { golden, realV2 } from "./validate-fixtures";

// Tests mutate deep wire paths freely: the body is untyped JSON here on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
// Q3 is config-driven (config lint.resolverTables); the tests configure one project's tables.
const RESOLVER_TABLES = { feature_config: "features_getEnabledForLevel", feature_status: "features_getEnabledForLevel" };
const rules = (b: unknown, docs = false) => lintMethodV2(b, { docs, resolverTables: RESOLVER_TABLES }).map((f) => f.rule);

function withSql(sql: string): Body {
  const b = golden() as Body;
  b.steps[2].inputs[0].properties[0].value = sql;
  return b;
}

describe("SQL rules", () => {
  test("Q2: subquery in the SELECT list (not in FROM/WHERE)", () => {
    expect(rules(withSql("select a, (select max(x) from t2) as m from t1"))).toContain("Q2");
    expect(rules(withSql("select a from t1 where b in (select b from t2)"))).not.toContain("Q2");
    expect(rules(withSql("select s.a from (select a from t1) s"))).not.toContain("Q2");
  });

  test("Q3: no resolver tables configured → no Q3 (nothing project-specific is built in)", () => {
    expect(lintMethodV2(withSql("select details from feature_config where code = :c")).map((f) => f.rule)).not.toContain("Q3");
  });

  test("Q3: feature_config / feature_status read directly", () => {
    expect(rules(withSql("select details from feature_config where code = :c"))).toContain("Q3");
    expect(rules(withSql("select * from features_getEnabledForLevel(:lvl) f join feature_status s on true"))).not.toContain("Q3");
    expect(rules(withSql("select * from features_config_log"))).not.toContain("Q3");
  });

  test("Q4: returns only what it filters by equality to a :param", () => {
    expect(rules(withSql("select id from users where id = :id"))).toContain("Q4");
    expect(rules(withSql("select u.id, u.code from users u where u.id = :id and u.code = :code"))).toContain("Q4");
    expect(rules(withSql("select name from users where id = :id"))).not.toContain("Q4");
    expect(rules(withSql("select id from users where id = :id or id = :other"))).not.toContain("Q4");
  });

  test("Q6: a uuid-like column compared as text to a bound value", () => {
    for (const sql of [
      "select name from users where id::text = '#{userId}'",
      "select name from users u where u.user_id::varchar = :userId",
      "select name from users where '#{userId}' = owner_uuid::text",
      "select name from users where group_id::text in ('#{a}', '#{b}')",
      "select name from users where ID :: TEXT = #{userId}",
    ]) {
      expect(rules(withSql(sql))).toContain("Q6");
    }
    const f = lintMethodV2(withSql("select name from users u where u.id::text = '#{userId}'")).find((x) => x.rule === "Q6");
    expect(f?.message).toStartWith("u.id::text is compared");
    expect(f?.fix).toContain("u.id = '#{x}'::uuid");
    for (const sql of [
      "select name from users where id = '#{userId}'::uuid",
      "select name from users where id = :userId::uuid",
      "select name from users where code::text = '#{code}'",
      "select id::text as id from users where name = :n",
      "select name from users where id::text = 'literal'",
      "select name from users where id::text = other_id::text",
    ]) {
      expect(rules(withSql(sql))).not.toContain("Q6");
    }
  });

  test("AD-LINT-002: SQL that reads no table", () => {
    expect(rules(withSql("select to_char(now(), 'YYYY')"))).toContain("AD-LINT-002");
    expect(rules(withSql("select 1 from users limit 1"))).not.toContain("AD-LINT-002");
    expect(rules(withSql("with x as (select 1) insert into t select * from x"))).not.toContain("AD-LINT-002");
  });

  test("AD-LINT-003: SQL built by replacePlaceholdersInText", () => {
    const b = withSql("#{builtQuery}");
    b.steps[1] = { serviceName: "Schools-Utilities", methodName: "replacePlaceholdersInText", properties: { type: "EXISTING_SERVICE" }, inputs: [], outputs: [{ key: "response", fieldCode: "builtQuery", name: "builtQuery" }] };
    expect(rules(b)).toContain("AD-LINT-003");
    expect(rules(withSql("select * from t where a = #{name}"))).not.toContain("AD-LINT-003");
  });
});

describe("anti-patterns and prose rules", () => {
  test("AD-LINT-001: JSON-juggling custom code", () => {
    expect(isJsonJuggling("const o = JSON.parse('#{payload}');\no.status = 'done';\nconsole.log(JSON.stringify(o));")).toBe(true);
    expect(isJsonJuggling("const o = JSON.parse('#{payload}');\nconsole.log(o.status);")).toBe(true);
    expect(isJsonJuggling("const o = JSON.parse('#{p}');\nconsole.log(JSON.stringify(o.items.map(i => i.id)));")).toBe(false);
    expect(isJsonJuggling("const o = JSON.parse('#{p}');\no.a = 1;\no.b = 2;\nconsole.log(JSON.stringify(o));")).toBe(false);
    expect(isJsonJuggling("console.log('#{greeting}'.toUpperCase())")).toBe(false);
    const b = golden() as Body;
    b.steps[1].properties.customCode.inlineCode = "const o = JSON.parse('#{greeting}');\nconsole.log(o.name);";
    expect(rules(b)).toContain("AD-LINT-001");
    expect(rules(golden())).not.toContain("AD-LINT-001");
  });

  test("AD-LINT-004 / 008 / 009: reserved key, BASE_64 variable, long FLOAT default", () => {
    const b = golden() as Body;
    b.inputs.push({ key: "language", name: "language", type: "STRING" });
    b.variables.push({ key: "blob", name: "blob", type: "STRING", encodingType: "BASE_64" });
    b.variables.push({ key: "ratio", name: "ratio", type: "FLOAT", defaultValue: "3.14159265" });
    b.variables.push({ key: "ok", name: "ok", type: "FLOAT", defaultValue: "3.14159" });
    const r = lintMethodV2(b);
    expect(r.map((f) => f.rule).sort()).toEqual(["AD-LINT-002", "AD-LINT-004", "AD-LINT-008", "AD-LINT-009"]);
    expect(r.find((f) => f.rule === "AD-LINT-009")?.path).toBe("variables[2].defaultValue");
  });

  test("AD-LINT-005: more than 30 steps", () => {
    const b = golden() as Body;
    b.steps = Array.from({ length: 31 }, () => structuredClone((golden() as Body).steps[0]));
    expect(rules(b)).toContain("AD-LINT-005");
    expect(rules(golden())).not.toContain("AD-LINT-005");
  });

  test("AD-LINT-006: echo reads and writes the same variable", () => {
    const b = golden() as Body;
    b.steps[0].inputs[0].value = "#{greeting} again";
    expect(rules(b)).toContain("AD-LINT-006");
    expect(rules(golden())).not.toContain("AD-LINT-006");
  });

  test("AD-LINT-007: + on two numeric inputs without a cast", () => {
    const b = golden() as Body;
    b.inputs.push({ key: "a", name: "a", type: "NUMBER" }, { key: "c", name: "c", type: "INTEGER" });
    b.steps[0].inputs[0].value = "#{a + c}";
    expect(rules(b)).toContain("AD-LINT-007");
    b.steps[0].inputs[0].value = "#{T(java.lang.Integer).parseInt(a) + T(java.lang.Integer).parseInt(c)}";
    expect(rules(b)).not.toContain("AD-LINT-007");
    b.steps[0].inputs[0].value = "#{name + a}"; // name is STRING: concatenation is intended
    expect(rules(b)).not.toContain("AD-LINT-007");
  });

  test("AD-LINT-010 only with docs", () => {
    expect(rules(golden())).not.toContain("AD-LINT-010");
    const docs = lintMethodV2(golden(), { docs: true }).filter((f) => f.rule === "AD-LINT-010");
    expect(docs.map((f) => f.path)).toContain("inputs");
    expect(docs.some((f) => f.step?.orderIndex === 1)).toBe(true);
  });

  test("every emitted rule is catalogued and advisory", () => {
    for (const { body } of realV2()) {
      for (const f of lintMethodV2(body, { docs: true })) {
        expect(Object.keys(LINT_RULES)).toContain(f.rule);
        expect(f.severity).toBe("warn");
      }
    }
  });
});

describe("calibration over the 36 real acme-dev bodies", () => {
  test("lint counts are pinned (docs off): few, specific findings", () => {
    const counts: Record<string, number> = {};
    for (const { body } of realV2()) for (const f of lintMethodV2(body, { resolverTables: RESOLVER_TABLES })) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
    expect(counts).toEqual({ "AD-LINT-003": 4, Q2: 3, Q3: 2 });
  });
});

// ── command ──────────────────────────────────────────────────────────────

let ff: FakeFetch | null = null;
let cfg: TempEnvConfig | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  ff?.restore();
  ff = null;
  cfg?.restore();
  cfg = null;
  while (spies.length) spies.pop()!.mockRestore();
});

describe("ad lint command", () => {
  const real = () => realV2().find((r) => r.file.startsWith("4629ab57"))!;

  test("uuid: validator errors + lint warnings grouped by step; errors → AD_LINT_FAILED", async () => {
    cfg = withTempEnvConfig({ envs: { "t-lint": { url: "https://t.test" } }, activeEnv: "t-lint" });
    spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
    const { file, body } = real();
    const uuid = file.slice(0, 32);
    ff = fakeFetch({ [`GET /rest/api/automation/chain/v2/${uuid}`]: body }).install();
    const r = await runCommand(lintCommand, [uuid], { env: "t-lint" });
    expect(r.envelope?.error?.code).toBe("AD_LINT_FAILED");
    const d = r.envelope?.data as any;
    expect(d.byRule["AD-LINT-003"]).toBe(2);
    expect(d.byRule.CI1).toBeGreaterThan(0);
    const step7 = d.groups.find((g: any) => g.orderIndex === 7);
    expect(step7.scope).toBe("step 7 SQL db_service/data.read");
    expect(step7.findings.map((f: any) => f.rule)).toContain("AD-LINT-003");
    expect(d.groups.map((g: any) => g.orderIndex)).toEqual([...d.groups.map((g: any) => g.orderIndex)].sort((a: number | null, b: number | null) => (a ?? -1) - (b ?? -1)));
    expect(ff.requests.every((q) => q.method === "GET")).toBe(true);
  });

  test("file: warnings only → ok; --strict turns them into errors", async () => {
    const dir = scratchDir("ad-lint");
    const file = join(dir, "m.v2.json");
    writeFileSync(file, JSON.stringify(golden()));
    const r = await runCommand(lintCommand, [file], {});
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).byRule).toMatchObject({ "AD-LINT-002": 1 });
    const strict = await runCommand(lintCommand, [file, "--strict"], {});
    expect(strict.envelope?.error?.code).toBe("AD_LINT_FAILED");
  });

  test("Q3 tables come from config lint.resolverTables", async () => {
    const dir = scratchDir("ad-lint");
    const file = join(dir, "q3.v2.json");
    writeFileSync(file, JSON.stringify(withSql("select v from app_settings where k = :k")));
    cfg = withTempEnvConfig({ envs: { "t-lint": { url: "https://t.test" } } });
    expect((await runCommand(lintCommand, [file], {})).envelope?.data as any).not.toHaveProperty("byRule.Q3");
    cfg.restore();
    cfg = withTempEnvConfig({ envs: { "t-lint": { url: "https://t.test" } } });
    const raw = JSON.parse(readFileSync(cfg.configPath, "utf8"));
    writeFileSync(cfg.configPath, JSON.stringify({ ...raw, lint: { resolverTables: { app_settings: "settings_get" } } }));
    reloadConfig();
    expect(((await runCommand(lintCommand, [file], {})).envelope?.data as any).byRule.Q3).toBe(1);
  });

  test("a missing / invalid file has a stable code", async () => {
    const dir = scratchDir("ad-lint");
    expect((await runCommand(lintCommand, [join(dir, "none.json")], {})).envelope?.error?.code).toBe("FILE_NOT_FOUND");
    writeFileSync(join(dir, "bad.json"), "{");
    expect((await runCommand(lintCommand, [join(dir, "bad.json")], {})).envelope?.error?.code).toBe("INVALID_JSON");
  });

  test("a compact create spec is expanded first, as create --dry-run does", async () => {
    cfg = withTempEnvConfig({ envs: { "t-lint": { url: "https://t.test" } }, activeEnv: "t-lint" });
    spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));
    const CATS = `${import.meta.dir}/../fixtures/categories`;
    ff = fakeFetch([
      { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=false", response: fixture(`${CATS}/chain-category.json`) },
      { method: "GET", url: "/rest/api/automation/chain/category?fetchSystemServices=true", response: fixture(`${CATS}/chain-category-system.json`) },
    ]).install();
    const dir = scratchDir("ad-lint");
    const file = join(dir, "greet.spec.json");
    const spec = { name: "belz_tst_lint_spec", category: "Test-Tester", inputs: ["name"], outputs: ["greeting"], steps: [{ code: "const greeting = 'Hello, ' + name;", outputs: ["greeting"] }] };
    writeFileSync(file, JSON.stringify(spec));
    for (const cmd of [lintCommand, validateCommand] as const) {
      const r = await runCommand(cmd as typeof lintCommand, [file], { env: "t-lint" });
      const d = r.envelope?.data as any;
      expect(JSON.stringify(r.envelope?.error ?? null)).not.toContain("Expected array");
      expect(d.spec).toMatchObject({ expanded: true, category: { chainCategoryId: 1135, name: "Test-Tester" } });
      expect(d.name).toBe("belz_tst_lint_spec");
    }
    expect(ff.requests.every((q) => q.method === "GET")).toBe(true);
    // a V2 body is not a spec; --category only applies to one
    expect(isCompactSpec(golden())).toBe(false);
    expect(realV2().filter((r) => isCompactSpec(r.body)).map((r) => r.file)).toEqual([]);
    expect(isCompactSpec(spec)).toBe(true);
    const v2 = join(dir, "m.v2.json");
    writeFileSync(v2, JSON.stringify(golden()));
    expect((await runCommand(lintCommand, [v2, "--category", "1135"], { env: "t-lint" })).envelope?.error?.code).toBe("INVALID_ARGUMENT");
  });

  test("groupFindings: method first, errors before warnings", () => {
    const g = groupFindings([
      { rule: "W1", severity: "warn", message: "", path: "steps[1].x", step: { orderIndex: 2, kind: "SQL" } },
      { rule: "E1", severity: "error", message: "", path: "steps[1].y" },
      { rule: "M", severity: "warn", message: "", path: "inputs" },
    ]);
    expect(g.map((x) => x.scope)).toEqual(["method", "step 2 SQL"]);
    expect(g[1]!.findings.map((f) => f.rule)).toEqual(["E1", "W1"]);
  });
});
