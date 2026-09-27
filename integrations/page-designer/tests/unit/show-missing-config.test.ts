// Regressions found by typechecking (Stage 3D):
// - `pd show` on a response without `configuration` crashed with a raw TypeError
//   (Buffer.byteLength(undefined)); it now fails with PD_CONFIG_MISSING.
// - components.json that is not a string array was silently accepted.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { runCommand, scratchDir, withTempEnvConfig } from "@belzabar/core/testing";
import showCommand from "../../commands/show/index";
import * as resolver from "../../lib/resolver";
import { loadComponentsWhitelist } from "../../lib/analyzer";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

describe("pd show without configuration", () => {
  test("-> ok:false PD_CONFIG_MISSING, not an internal TypeError", async () => {
    using _cfg = withTempEnvConfig({ envs: { "t-dev": { url: "https://t.test" } } });
    spies.push(
      spyOn(resolver, "resolveInput").mockResolvedValue({
        entityType: "PAGE",
        resolvedId: "p1",
        response: { name: "P" },
        inputKind: "id",
        source: "network",
      } as unknown as resolver.ResolvedEntity),
    );
    const r = await runCommand(showCommand, ["p1"], { env: "t-dev" });
    expect(r.envelope?.ok).toBe(false);
    expect(r.envelope?.error?.code).toBe("PD_CONFIG_MISSING");
  });
});

describe("loadComponentsWhitelist", () => {
  const dir = scratchDir("belz-pd-components-");

  test("loads a string array", async () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify(["a", "b"]));
    expect([...(await loadComponentsWhitelist("missing", p))]).toEqual(["a", "b"]);
  });

  test("missing file -> COMPONENTS_FILE_MISSING with the caller's message", async () => {
    await expect(loadComponentsWhitelist("nope!", join(dir, "absent.json"))).rejects.toMatchObject({
      code: "COMPONENTS_FILE_MISSING",
      message: "nope!",
    });
  });

  test.each([["{\"a\":1}"], ["[1,2]"], ["not json"]])("invalid content %p -> COMPONENTS_FILE_INVALID", async (body) => {
    const p = join(dir, "bad.json");
    writeFileSync(p, body);
    await expect(loadComponentsWhitelist("missing", p)).rejects.toMatchObject({ code: "COMPONENTS_FILE_INVALID" });
  });
});
