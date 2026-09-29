// no command listed a service's methods, so agents guessed
// (`Helpers.String/toUpperCase`) and hit 404-style rejections. Real acme-dev
// /automation-systems/{svc}/automation-apis listings (fixtures/services).
import { describe, expect, test } from "bun:test";
import { fakeFetch, fixture, respond, runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import servicesCommand, { serviceMethodRows } from "../../commands/services/index";

const FIX = `${import.meta.dir}/../fixtures/services`;
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };

describe("ad services <SERVICE>", () => {
  test("lists the service's methods: the name compact steps take, label, apiUuid", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({
      "GET /rest/api/automation-systems/Helpers.String/automation-apis": fixture(`${FIX}/helpers-string.automation-apis.json`),
    }).install();
    const r = await runCommand(servicesCommand, ["Helpers.String"], { env: "t-dev" });
    const d = r.envelope?.data as any;
    expect(d.service).toBe("Helpers.String");
    expect(d.methods.map((m: any) => m.method)).toEqual(["asJSON", "echo", "escapeSpecialCharacters", "unescapeSpecialCharacters"]);
    expect(d.methods[1].apiUuid).toMatch(/^[0-9a-f]{32}$/); // trimmed
  });

  test("db_service: labels kept, hidden methods only with --all; --search ranks", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({
      "GET /rest/api/automation-systems/db_service/automation-apis": fixture(`${FIX}/db-service.automation-apis.json`),
    }).install();
    const d = (await runCommand(servicesCommand, ["db_service"], { env: "t-dev" })).envelope?.data as any;
    expect(d.methods.find((m: any) => m.method === "select")).toMatchObject({ label: "data.read" });
    expect(d.methods.some((m: any) => m.method === "poolRegister")).toBe(false);
    const all = (await runCommand(servicesCommand, ["db_service", "--all"], { env: "t-dev" })).envelope?.data as any;
    expect(all.methods.find((m: any) => m.method === "poolRegister")).toMatchObject({ hidden: true });
    const s = (await runCommand(servicesCommand, ["db_service", "--search", "read"], { env: "t-dev" })).envelope?.data as any;
    expect(s.methods[0].method).toBe("select");
  });

  test("an unknown service (the server answers []) warns; bad flag combos are refused", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch({ "GET /rest/api/automation-systems/*": respond({ json: [] }) }).install();
    const r = await runCommand(servicesCommand, ["No.Such"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as any).methods).toEqual([]);
    expect(String((r.envelope?.meta.warnings as string[] | undefined)?.[0])).toContain("No visible methods");
    expect((await runCommand(servicesCommand, ["X", "--internal"], { env: "t-dev" })).envelope?.error?.code).toBe("INVALID_ARGUMENT");
    expect((await runCommand(servicesCommand, ["--all"], { env: "t-dev" })).envelope?.error?.code).toBe("INVALID_ARGUMENT");
    expect(serviceMethodRows(null, false)).toEqual([]);
  });
});
