// platform/entities.ts — the shared "not found = 404 or empty 2xx" rule for raw AD chain / PD page GETs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CliError } from "../src/command";
import { adChainPath, fetchRawChain, fetchRawPage, pdPagePath } from "../src/platform";
import { fakeFetch, respond, type FakeFetch } from "../src/testing/fake-fetch";
import { withTempEnvConfig, type TempEnvConfig } from "../src/testing/env-config";

let cfg: TempEnvConfig;
let ff: FakeFetch;
const onError = (res: Response) => new CliError(`boom ${res.status}`, { code: "X_ERR" });

beforeEach(() => {
  cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t-dev.test" } }, activeEnv: "t-dev" });
  ff = fakeFetch({
    [`GET ${adChainPath("a1")}`]: { uuid: "a1", name: "M" },
    [`GET ${adChainPath("empty")}`]: respond({ status: 200, text: "  " }),
    [`GET ${adChainPath("null")}`]: respond({ status: 200, text: "null" }),
    [`GET ${adChainPath("html")}`]: respond({ status: 200, text: "<html>" }),
    [`GET ${pdPagePath("gone")}`]: respond({ status: 404, text: "" }),
    [`GET ${pdPagePath("down")}`]: respond({ status: 503, text: "down" }),
  }).install();
});
afterEach(() => {
  ff.restore();
  cfg.restore();
});

describe("fetchRawEntity", () => {
  test("found body", async () => {
    expect(await fetchRawChain("a1", { onError })).toEqual({ found: true, body: { uuid: "a1", name: "M" } });
  });

  test("empty and null 2xx bodies are not found", async () => {
    expect(await fetchRawChain("empty", { onError })).toEqual({ found: false, reason: "empty" });
    expect(await fetchRawChain("null", { onError })).toEqual({ found: false, reason: "empty" });
  });

  test("non-JSON 2xx: empty by default, or the caller's badJson error", async () => {
    expect(await fetchRawChain("html", { onError })).toEqual({ found: false, reason: "empty" });
    await expect(fetchRawChain("html", { onError, badJson: () => new CliError("bad", { code: "X_BAD" }) })).rejects.toMatchObject({ code: "X_BAD" });
  });

  test("404 hands back the response; other non-OK goes through onError", async () => {
    const got = await fetchRawPage("gone", { onError });
    expect(got.found).toBe(false);
    expect(!got.found && got.reason).toBe("http-404");
    await expect(fetchRawPage("down", { onError })).rejects.toMatchObject({ code: "X_ERR", message: "boom 503" });
  });
});
