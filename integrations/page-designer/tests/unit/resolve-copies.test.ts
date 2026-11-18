// Which copy a read uses (F1), ids that differ per env (F5) and what `pd diff`
// says differs (F4). Two fake envs, each its own in-memory PD server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR, Config } from "@belzabar/core";
import { fakeFetch, runCommand, withTempEnvConfig, type FakeFetch, type RecordedRequest, type TempEnvConfig } from "@belzabar/core/testing";
import diff from "../../commands/diff/index";
import show from "../../commands/show/index";
import { resolveInput } from "../../lib/resolver";
import { cleanInner, page } from "./helpers/fake-pd";
import type { RawPageResponse } from "../../lib/types/wire";

const DEV_DRAFT = "d0000000000000000000000000000001";
const DEV_PUB = "d0000000000000000000000000000002";
const QA_DRAFT = "e0000000000000000000000000000001";
const QA_PUB = "e0000000000000000000000000000002";
const LONE = "d0000000000000000000000000000003";
const GONE_DRAFT = "d0000000000000000000000000000004";
const GONE_PUB = "d0000000000000000000000000000005";

const withDerived = (spec: string) =>
  cleanInner({
    variables: {
      generated: [],
      userDefined: [
        { name: "greeting", type: "String", initialValue: "hi" },
        { name: "perm", type: "Any", from: ["greeting"], spec, sideEffect: true },
      ],
      derived: [],
    },
  });

const servers: Record<string, Map<string, RawPageResponse>> = {};
let ff: FakeFetch;
let cfg: TempEnvConfig;

function handler(req: RecordedRequest): Response {
  const u = new URL(req.url);
  const pages = servers[u.hostname]!;
  const path = u.pathname.replace("/rest/api/pagedesigner", "");
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (path === "/pages" && u.searchParams.has("name")) {
    return json(
      [...pages.values()]
        .filter((p) => p.name === u.searchParams.get("name") && p.status === u.searchParams.get("status"))
        .map(({ configuration: _c, ...row }) => row),
    );
  }
  const m = path.match(/^\/pages\/(\w+)$/);
  const p = m ? pages.get(m[1]!) : undefined;
  return p ? json(p) : json({ message: "not found" }, 404);
}

beforeEach(() => {
  for (const env of ["t-dev", "t-qa"]) rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", env), { recursive: true, force: true });
  const comp = { isComponent: true, relativeRoute: undefined };
  servers["dev.test"] = new Map([
    [DEV_DRAFT, page(DEV_DRAFT, withDerived("a\nb2\nc"), { ...comp, name: "widget", referenceId: DEV_PUB, versionId: 20 })],
    [DEV_PUB, page(DEV_PUB, withDerived("a\nb\nc"), { ...comp, name: "widget", status: "PUBLISHED", referenceId: DEV_DRAFT, versionId: 19 })],
    [LONE, page(LONE, cleanInner(), { name: "lonely" })],
    [GONE_DRAFT, page(GONE_DRAFT, cleanInner(), { name: "gone", referenceId: GONE_PUB })],
    [GONE_PUB, page(GONE_PUB, cleanInner(), { name: "gone", status: "DELETED" as "DRAFT", referenceId: GONE_DRAFT })],
  ]);
  // QA has the same component under different ids (created there, not migrated).
  servers["qa.test"] = new Map([
    [QA_DRAFT, page(QA_DRAFT, withDerived("a\nb\nc"), { ...comp, name: "widget", referenceId: QA_PUB, versionId: 7 })],
    [QA_PUB, page(QA_PUB, withDerived("a\nb\nc"), { ...comp, name: "widget", status: "PUBLISHED", referenceId: QA_DRAFT, versionId: 6 })],
  ]);
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://dev.test" }, "t-qa": { url: "https://qa.test" } }, defaultEnv: "t-dev" });
  Config.setActiveEnv("t-dev");
  ff = fakeFetch([{ url: /.*/, response: handler }]).install();
});
afterEach(() => {
  ff.restore();
  cfg.restore();
});

describe("resolveInput: which copy (F1)", () => {
  test("a name reads the DRAFT and says so", async () => {
    const r = await resolveInput("widget", true);
    expect(r).toMatchObject({ resolvedId: DEV_DRAFT, resolvedAs: "DRAFT" });
    expect(r.switchedFrom).toBeUndefined();
  });

  test("--version published follows referenceId; draft goes the other way", async () => {
    expect(await resolveInput("widget", true, { version: "published" })).toMatchObject({ resolvedId: DEV_PUB, resolvedAs: "PUBLISHED", switchedFrom: DEV_DRAFT });
    expect(await resolveInput(DEV_PUB, true, { version: "draft" })).toMatchObject({ resolvedId: DEV_DRAFT, resolvedAs: "DRAFT", switchedFrom: DEV_PUB });
    expect(await resolveInput(DEV_DRAFT, true, { version: "draft" })).toMatchObject({ resolvedId: DEV_DRAFT, resolvedAs: "DRAFT" });
  });

  test("no published copy, or a DELETED one → PD_VERSION_NOT_FOUND", async () => {
    await expect(resolveInput(LONE, true, { version: "published" })).rejects.toMatchObject({ code: "PD_VERSION_NOT_FOUND" });
    await expect(resolveInput(GONE_DRAFT, true, { version: "published" })).rejects.toMatchObject({
      code: "PD_VERSION_NOT_FOUND",
      message: expect.stringContaining("is DELETED"),
    });
  });
});

describe("pd show", () => {
  test("data.resolvedAs comes first; a name read as the DRAFT warns", async () => {
    const r = await runCommand(show, ["widget", "--force"], { env: "t-dev" });
    const data = r.envelope!.data as Record<string, unknown>;
    expect(Object.keys(data)[0]).toBe("resolvedAs");
    expect(data.resolvedAs).toBe("DRAFT");
    expect(JSON.stringify(r.envelope!.meta)).toContain("--version published");
  });

  test("--version published reads the published row", async () => {
    const r = await runCommand(show, ["widget", "--version", "published", "--force"], { env: "t-dev" });
    expect(r.envelope!.data).toMatchObject({ resolvedAs: "PUBLISHED", switchedFrom: DEV_DRAFT, summary: { resolvedId: DEV_PUB } });
  });

  test("F5: a dev id on --env qa resolves by its name there", async () => {
    const r = await runCommand(show, [DEV_DRAFT, "--force"], { env: "t-qa" });
    expect(r.envelope!.ok).toBe(true);
    expect(r.envelope!.data).toMatchObject({
      resolvedAs: "DRAFT",
      byNameFrom: { env: "t-dev", id: DEV_DRAFT, name: "widget" },
      summary: { resolvedId: QA_DRAFT },
    });
  });

  test("F5: an id whose name is not on the env either → NOT_FOUND naming both", async () => {
    const r = await runCommand(show, [LONE, "--force"], { env: "t-qa" });
    expect(r.envelope!.error).toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining('its name "lonely"') });
  });
});

describe("pd diff (F1, F4, F5)", () => {
  test("says which copy each side read, the direction, and what differs", async () => {
    const r = await runCommand(diff, ["widget", "--from", "t-dev", "--to", "t-qa"], { env: "t-dev" });
    const data = r.envelope!.data as any;
    expect(data.resolvedAs).toBe("DRAFT");
    expect(data.from).toMatchObject({ resolvedId: DEV_DRAFT, resolvedAs: "DRAFT" });
    expect(data.to).toMatchObject({ resolvedId: QA_DRAFT, resolvedAs: "DRAFT" });
    expect(data.direction).toEqual({ added: "only in t-qa", removed: "only in t-dev" });
    expect(data.diff.derived.changed).toEqual(["perm"]);
    expect(data.changes).toEqual([{ kind: "derived", name: "perm", paths: [{ path: "spec", line: 2, from: "b2", to: "b" }] }]);
  });

  test("--version published compares the published copies", async () => {
    const r = await runCommand(diff, ["widget", "--from", "t-dev", "--to", "t-qa", "--version", "published"], { env: "t-dev" });
    const data = r.envelope!.data as any;
    expect(data.resolvedAs).toBe("PUBLISHED");
    expect([data.from.resolvedId, data.to.resolvedId]).toEqual([DEV_PUB, QA_PUB]);
    expect(data.identical).toBe(true);
    expect(data.changes).toEqual([]);
  });

  test("a dev id is resolved on qa by its name", async () => {
    const r = await runCommand(diff, [DEV_DRAFT, "--from", "t-dev", "--to", "t-qa"], { env: "t-dev" });
    expect((r.envelope!.data as any).to).toMatchObject({ resolvedId: QA_DRAFT, byNameFrom: { env: "t-dev", name: "widget" } });
  });
});
