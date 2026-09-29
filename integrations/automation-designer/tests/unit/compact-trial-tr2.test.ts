// CLI trial tr2 (acme-dev 2026-09-29): compact-format friction.
//  - An omitted db_service account defaults only when the service has exactly
//    one account; otherwise the error says how many and lists id=nickname.
//  - An indexed / pathed step output key (`flatData[0].greeting`) is refused
//    with the reason and the pattern that works (live: the V2 route stores the
//    contract key or drops the output, and drops elementToRetrieve on non-code
//    steps; an echo `#{rows[0].greeting}` step returned the scalar).
import { describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { planV2Overlay } from "../../lib/serialize/v2";
import { emptyCatalog, indexedOutputHint, type ServiceCatalog } from "../../lib/serialize/compact";
import type { V2MethodResponse } from "../../lib/types/v2-wire";

const FIX = `${import.meta.dir}/../fixtures`;
const ON = `${FIX}/validate/online`;
const live = (): V2MethodResponse => structuredClone(require(`${FIX}/real-v2/41bb1b438875bd8b994196db1f12b7c2.v2.json`));

function catalog(): ServiceCatalog {
  const c = emptyCatalog();
  c.contracts.set("Helpers.Legacy/echo", require(`${ON}/api-echo.json`));
  c.contracts.set("db_service/data.read", require(`${ON}/api-db-select.json`));
  c.accounts.set("db_service", (require(`${ON}/auth-db_service.json`) as Array<{ id: number; nickname: string }>).map((a) => ({ id: a.id, nickname: a.nickname })));
  return c;
}

function failure(ops: unknown[], cat = catalog()): CliError {
  try {
    planV2Overlay(live(), { ops }, { catalog: cat });
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError");
}

describe("db_service account default (tr2 #1)", () => {
  test("several accounts, none named: refused, message counts and lists id=nickname", () => {
    const accounts = catalog().accounts.get("db_service")!;
    expect(accounts.length).toBeGreaterThan(1);
    const e = failure([{ op: "add-step", step: { sql: "SELECT 1" } }]);
    const text = `${e.message} ${JSON.stringify(e.details)}`;
    expect(text).toContain(`db_service has ${accounts.length} accounts on this env, so the step must name one`);
    for (const a of accounts) expect(text).toContain(`${a.id}=${a.nickname}`);
  });

  test("exactly one account: it is the default", () => {
    const one = catalog();
    one.accounts.set("db_service", [{ id: 7, nickname: "only" }]);
    const q = planV2Overlay(live(), { ops: [{ op: "add-step", step: { sql: "SELECT 1" } }] }, { catalog: one });
    expect(q.body.steps!.at(-1)!.accountConfiguration).toEqual({ id: 7, name: "only" });
  });
});

describe("indexed SQL step outputs (tr2 #2)", () => {
  test("flatData[0].col is refused with the echo-reduce pattern", () => {
    const e = failure([{ op: "add-step", step: { sql: "SELECT 1 AS greeting", account: 2, outputs: { greeting: "flatData[0].greeting" } } }]);
    const text = `${e.message} ${JSON.stringify(e.details)}`;
    expect(e.code).toBe("AD_OVERLAY_NOT_APPLIED");
    expect(text).toContain("cannot be indexed or pathed");
    expect(text).toContain("#{greetingRows[0].greeting}");
  });

  test("the whole output still binds", () => {
    const q = planV2Overlay(
      live(),
      { ops: [{ op: "add-step", step: { sql: "SELECT 1 AS greeting", account: 2, outputs: { rows: "flatData[]" } } }] },
      { catalog: catalog() },
    );
    expect(q.body.steps!.at(-1)!.outputs).toEqual([expect.objectContaining({ key: "flatData[]", fieldCode: "rows" })]);
  });

  test("indexedOutputHint: pathed/indexed keys only; also without a contract", () => {
    const known = ["columnNames[]", "data[].rowColumns[]", "flatData[]", "responseFile", "rowsImpacted"];
    expect(indexedOutputHint({ key: "flatData[]", as: "rows" }, known)).toBeNull();
    expect(indexedOutputHint({ key: "rowsImpacted", as: "n" }, known)).toBeNull();
    expect(indexedOutputHint({ key: "flatData[].greeting", as: "g" }, known)).toContain("#{gRows[0].greeting}");
    expect(indexedOutputHint({ key: "flatData[0]", as: "first" }, known)).toContain("#{firstRows[0]}");
    expect(indexedOutputHint({ key: "flatData[2].x", as: "x" }, [])).toContain("'flatData[]'");
    expect(indexedOutputHint({ key: "response", as: "r" }, [])).toBeNull();
  });
});
