// fix-verify / CLI trial: V1 keeps serving a soft-deleted draft (no V1 field
// marks it), so `ad show` / `ad fetch` presented it as live while `show
// --compact` (V2) said METHOD_NOT_FOUND. The V1 path now reads V2 beside it.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { fakeFetch, respond, runCommand, withTempEnvConfig, type RecordedRequest } from "@belzabar/core/testing";
import showCommand from "../../commands/show/index";
import fetchCommand from "../../commands/fetch/index";

const FIX = `${import.meta.dir}/../fixtures`;
const UUID = "4a49e392ca76084725c3839ff97007ae";
const ENVS = { envs: { "t-dev": { url: "https://t.test" } }, activeEnv: "t-dev" };
const v1 = JSON.parse(readFileSync(`${FIX}/real-v1/${UUID}.v1.json`, "utf8"));
const v2 = JSON.parse(readFileSync(`${FIX}/real-v2/${UUID}.v2.json`, "utf8"));

function routes(v2Response: unknown) {
  return [
    { method: "GET", url: `/rest/api/automation/chain/${UUID}`, response: v1 },
    { method: "GET", url: new RegExp(`/chain/v2/${UUID}`), response: v2Response },
    {
      method: "GET",
      url: /\/rest\/api\/automations\/(\d+)/,
      response: (req: RecordedRequest) => {
        const f = `${FIX}/definitions/${/automations\/(\d+)/.exec(req.url)![1]}.json`;
        return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : respond({ status: 404, text: "" });
      },
    },
  ];
}

describe("show / fetch on a soft-deleted method", () => {
  const deleted = [
    ["200 + empty body", respond({ text: "" })],
    ["400 automationAPI is null", respond({ status: 400, json: { errorMessage: 'Cannot invoke "…getId()" because "automationAPI" is null' } })],
  ] as const;
  for (const [label, answer] of deleted) {
    test(`V2 ${label} → METHOD_NOT_FOUND {deleted: true}`, async () => {
      using _cfg = withTempEnvConfig(ENVS);
      using _ff = fakeFetch(routes(answer)).install();
      for (const cmd of [showCommand, fetchCommand]) {
        const r = await runCommand(cmd as typeof showCommand, [UUID], { env: "t-dev" });
        expect(r.envelope?.error?.code).toBe("METHOD_NOT_FOUND");
        expect(r.envelope?.error?.details).toMatchObject({ deleted: true });
      }
    });
  }

  test("a live method still shows (a successful V2 read clears the gone mark); a V2 read that fails otherwise does not block V1", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using _ff = fakeFetch(routes(v2)).install();
    const live = await runCommand(showCommand, [UUID, "--force"], { env: "t-dev" });
    expect(live.envelope?.error ?? null).toBeNull();
    _ff.restore();
    using _ff2 = fakeFetch(routes(respond({ status: 500, text: "conversion failed" }))).install();
    expect((await runCommand(fetchCommand, [UUID], { env: "t-dev" })).envelope?.ok).toBe(true);
  });

  test("a cached copy is refused once the uuid is known deleted", async () => {
    using _cfg = withTempEnvConfig(ENVS);
    using ff = fakeFetch(routes(v2)).install();
    expect((await runCommand(showCommand, [UUID, "--force"], { env: "t-dev" })).envelope?.ok).toBe(true); // cached now
    ff.restore();
    using _ff2 = fakeFetch(routes(respond({ text: "" }))).install();
    await runCommand(showCommand, [UUID, "--compact"], { env: "t-dev" }); // V2 NOT_FOUND → gone mark
    const r = await runCommand(showCommand, [UUID], { env: "t-dev" });
    expect(r.envelope?.error?.details).toMatchObject({ deleted: true });
  });
});
