// Stage 7.9: compact default output (+ --fields / --full) for `categories`,
// `changelog`, `export`, `export-category` and `history show`, on real
// sems-dev fixtures.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fakeFetch, runCommand, withTempEnvConfig, type RecordedRequest } from "@belzabar/core/testing";
import categoriesCommand from "../../commands/categories/index";
import changelogCommand, { entryRows } from "../../commands/changelog/index";
import exportCommand from "../../commands/export/index";
import exportCategoryCommand from "../../commands/export-category/index";
import historyCommand, { diffTableRows } from "../../commands/history/index";
import { adApi, type ChangelogEntry } from "../../lib/api/index";
import { htmlToText } from "../../lib/compact";
import { parseV1Method } from "../../lib/parser/v1";
import type { V1RawMethodResponse } from "../../lib/types/v1-wire";

const FIX = `${import.meta.dir}/../fixtures`;
const load = (p: string) => JSON.parse(readFileSync(join(FIX, p), "utf8"));
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});
const quiet = () => spies.push(spyOn(process.stderr, "write").mockImplementation(() => true));

describe("categories: compact rows, --fields", () => {
  function stub() {
    const chain = load("categories/chain-category.json");
    const systems = load("categories/chain-category-system.json");
    spies.push(spyOn(adApi, "listCategories").mockImplementation(async (o) => (o?.includeSystem ? systems : chain)));
    quiet();
  }

  test("default rows drop the chainCategory*/systemUuid duplicates", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    stub();
    const data = (await runCommand(categoriesCommand, ["--user"], { env: "t-dev" })).envelope?.data as any;
    const tp = data.categories.find((c: any) => c.name === "Test-Parth");
    expect(tp).toEqual({ id: 1135, uuid: "4e98700b2524e2accd47b4addf95ceca", name: "Test-Parth", type: "USER_GENERATED", systemId: 1318 });
    const all = (await runCommand(categoriesCommand, ["--user", "--fields", "all"], { env: "t-dev" })).envelope?.data as any;
    expect(all.categories.find((c: any) => c.name === "Test-Parth")).toMatchObject({ chainCategoryId: 1135, systemUuid: "4037ada88a1a3ac30a1c9e63b6b0eed6" });
    expect(JSON.stringify(data).length).toBeLessThan(JSON.stringify(all).length * 0.75);
  });

  test("--fields validates names", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    stub();
    const r = await runCommand(categoriesCommand, ["--fields", "nope"], { env: "t-dev" });
    expect(r.envelope?.error?.code).toBe("INVALID_VALUE");
  });
});

describe("changelog: plain-text entries", () => {
  // real entries (rich-text comments, full user objects) as embedded in a sems-dev V2 body
  const entries = load("real-v2/41f705aff6c768c033b4ad9840b69dde.v2.json").changelogs as ChangelogEntry[];

  test("htmlToText flattens the AD rich-text editor markup", () => {
    expect(htmlToText("Developer =&gt; Zinat<br id=\"isPasted\">Doc version =&gt; 1.1<br>Reason =&gt; &nbsp;FAILED")).toBe(
      "Developer => Zinat / Doc version => 1.1 / Reason => FAILED",
    );
  });

  test("default rows: id, when, author, note (no user object / HTML); --fields all = raw entries", () => {
    const rows = entryRows(entries, undefined);
    expect(Object.keys(rows[0]!).sort()).toEqual(["author", "id", "note", "when"]);
    expect(rows[0]!.note).toStartWith("Developer:Vandana / Ver:1.1 / Reason: change epid to uuid");
    expect(rows[0]!.when).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(entryRows(entries, "all")).toBe(entries as any);
    expect(Object.keys(entryRows(entries, "note,html")[0]!).sort()).toEqual(["html", "note"]);
    expect(JSON.stringify(rows).length).toBeLessThan(JSON.stringify(entries).length / 3);
  });

  test("command: list mode returns compact rows and no duplicate uuid", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    const raw = load("real-v1/41bb1b438875bd8b994196db1f12b7c2.v1.json") as V1RawMethodResponse;
    spies.push(
      spyOn(adApi, "fetchMethod").mockResolvedValue(parseV1Method(raw)),
      spyOn(adApi, "listChangelog").mockResolvedValue(entries),
    );
    const d = (await runCommand(changelogCommand, ["41bb1b438875bd8b994196db1f12b7c2"], { env: "t-dev" })).envelope?.data as any;
    expect(d.uuid).toBeUndefined();
    expect(d.chainUuid).toBe("41bb1b438875bd8b994196db1f12b7c2");
    expect(d.total).toBe(entries.length);
    expect(d.entries[0].user).toBeUndefined();
  });
});

describe("export / export-category: --out omits the body unless --full", () => {
  const body = { chainDefinition: { jsonDefinition: JSON.stringify({ name: "m1" }) }, testSuite: null };

  test("export --out → id, bytes, methods; --full adds preview; no --out keeps preview", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    quiet();
    spies.push(spyOn(adApi, "exportMethod").mockResolvedValue(body));
    const out = join(mkdtempSync(join(tmpdir(), "s7a-exp-")), "m.json");
    const a = (await runCommand(exportCommand, ["20037", "--out", out], { env: "t-dev" })).envelope?.data as any;
    expect(a).toEqual({ id: 20037, uuid: null, writtenTo: out, bytes: expect.any(Number), methods: ["m1"] });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(body);
    const b = (await runCommand(exportCommand, ["20037", "--out", out, "--full"], { env: "t-dev" })).envelope?.data as any;
    expect(b.preview).toEqual(body);
    const c = (await runCommand(exportCommand, ["20037"], { env: "t-dev" })).envelope?.data as any;
    expect(c.preview).toEqual(body);
    expect(c.writtenTo).toBeUndefined();
  });

  test("export-category --out omits preview", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    quiet();
    spies.push(
      spyOn(adApi, "listCategories").mockImplementation(async (o) =>
        o?.includeSystem ? load("categories/chain-category-system.json") : load("categories/chain-category.json"),
      ),
      spyOn(adApi, "exportCategory").mockResolvedValue({ chainDefinitions: [body] }),
    );
    const out = join(mkdtempSync(join(tmpdir(), "s7a-expc-")), "c.json");
    const d = (await runCommand(exportCategoryCommand, ["Test-Parth", "--out", out], { env: "t-dev" })).envelope?.data as any;
    expect(d.methodCount).toBe(1);
    expect(d.preview).toBeUndefined();
    expect(d.writtenTo).toBe(out);
  });
});

describe("history show: compact view by default, --full adds the parse", () => {
  const DRAFT = "4bdea25c480a8e9dbc1cae830cb89b68";
  function wire() {
    quiet();
    return fakeFetch([
      { method: "GET", url: `/rest/api/automation/chain/${DRAFT}`, response: load("history/chain-v1-draft.json") },
      {
        method: "GET",
        url: /automation-systems\/Expertly\.Automation\.Method\.History\/automation-apis\//,
        response: (req: RecordedRequest) => ({ serviceChainUID: `hist-${req.url.split("/").pop()}` }),
      },
      { method: "POST", url: /chain\/execute\/hist-get/, response: () => load("history/get-draft-v3.json") },
      { method: "GET", url: /\/automations\/\d+/, response: {} },
    ]).install();
  }

  test("default: step lines, no HydratedMethod; --full: method present", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = wire();
    const lean = (await runCommand(historyCommand, ["show", DRAFT, "--version", "3"], { env: "t-dev" })).envelope?.data as any;
    expect(lean.method).toBeUndefined();
    expect(Array.isArray(lean.steps)).toBe(true);
    expect(lean.steps.length).toBe(lean.stepCount);
    for (const l of lean.steps) expect(typeof l).toBe("string");
    const full = (await runCommand(historyCommand, ["show", DRAFT, "--version", "3", "--full"], { env: "t-dev" })).envelope?.data as any;
    expect(full.method.parsedSteps.length).toBe(lean.stepCount);
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length / 3);
  });
});

describe("history diff human table (F36)", () => {
  test("rich-text descriptions become plain text cut to 60 chars", () => {
    const long = `[EXISTING_SERVICE] If &lt;insCnt&gt; &gt; 0<ul><li>Set queryToExecute = 'WITH' + ${"x".repeat(400)}</li></ul>`;
    const rows = diffTableRows([
      { orderIndex: 8, kind: "EXISTING_SERVICE", v1Desc: "(absent)", v2Desc: long, changed: true, detail: "Added" },
    ]);
    expect(rows[0]!.slice(0, 4)).toEqual([8, "EXISTING_SERVICE", "YES", "(absent)"]);
    const cell = String(rows[0]![4]);
    expect(cell.startsWith("[EXISTING_SERVICE] If <insCnt> > 0")).toBe(true);
    expect(cell).toContain("Set queryToExecute");
    expect(cell).not.toContain("<li>");
    expect(cell).toMatch(/…\(\+\d+\)$/);
    expect(cell.length).toBeLessThan(75);
    expect(rows[0]![5]).toBe("Added");
  });
});
