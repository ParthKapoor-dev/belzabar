// Regressions found by typechecking (Stage 3D):
// - `pd show` on a response without `configuration` crashed with a raw TypeError
//   (Buffer.byteLength(undefined)); it now fails with PD_CONFIG_MISSING.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runCommand, withTempEnvConfig } from "@belzabar/core/testing";
import showCommand from "../../commands/show/index";
import * as resolver from "../../lib/resolver";

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
