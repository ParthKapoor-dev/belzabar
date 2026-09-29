// PD argument parsing through core defineArgs (PD-16, PD-23, F34-class).
import { describe, expect, test } from "bun:test";
import type { CommandContext } from "@belzabar/core";
import publish from "../../commands/publish/index";
import show from "../../commands/show/index";
import pageDeps from "../../commands/page-deps/index";
import validate from "../../commands/validate/index";
import history from "../../commands/history/index";
import lock from "../../commands/lock/index";
import save from "../../commands/save/index";
import find from "../../commands/find/index";

const ctx = { outputMode: "llm" } as unknown as CommandContext;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error("expected a throw");
}

describe("pd publish (PD-16)", () => {
  test("--host without a value is MISSING_VALUE, not a silent publish-without-deploy", () => {
    expect(code(() => publish.parseArgs!(["abc", "--host", "--yes"], ctx))).toBe("MISSING_VALUE");
    expect(code(() => publish.parseArgs!(["abc", "--yes", "--host"], ctx))).toBe("MISSING_VALUE");
  });

  test("--host is repeatable; -y aliases --yes", async () => {
    const a = await publish.parseArgs!(["abc", "--host", "1", "--host=2", "-y", "--landing"], ctx);
    expect(a).toEqual({
      pageId: "abc",
      landing: true,
      hostIds: ["1", "2"],
      yes: true,
      overrides: { forceValidation: false, allowPublished: false, deprecatedForce: false },
    });
  });

  test("publish is a write", () => {
    expect(publish.writes).toBe(true);
  });
});

describe("pd show (PD-23)", () => {
  test("--var-detail / --node / --http-detail without a value → MISSING_VALUE", () => {
    expect(code(() => show.parseArgs!(["abc", "--var-detail"], ctx))).toBe("MISSING_VALUE");
    expect(code(() => show.parseArgs!(["abc", "--node", "--tree"], ctx))).toBe("MISSING_VALUE");
    expect(code(() => show.parseArgs!(["abc", "--http-detail"], ctx))).toBe("MISSING_VALUE");
    expect(code(() => show.parseArgs!(["abc", "--http-detail", "x"], ctx))).toBe("INVALID_VALUE");
  });

  test("unknown flags are rejected", () => {
    expect(code(() => show.parseArgs!(["abc", "--bogus"], ctx))).toBe("UNKNOWN_FLAG");
    expect(code(() => validate.parseArgs!(["abc", "--bogus"], ctx))).toBe("UNKNOWN_FLAG");
  });

  test("flags parse into the existing shape", async () => {
    const a = (await show.parseArgs!(["abc", "--var-detail", "x", "-r", "-o", "--http-detail=2"], ctx)) as any;
    expect(a.input).toBe("abc");
    expect(a.flags.varDetail).toBe("x");
    expect(a.flags.recursive).toBe(true);
    expect(a.flags.open).toBe(true);
    expect(a.flags.httpDetail).toBe(2);
    expect(a.flags.node).toBeNull();
    const b = (await show.parseArgs!(["abc"], ctx)) as any;
    expect(b.flags.httpDetail).toBe(-1);
    expect(code(() => show.parseArgs!([], ctx))).toBe("MISSING_INPUT");
  });
});

describe("pd page-deps", () => {
  test("--status needs a value and must be PUBLISHED|DRAFT", async () => {
    expect(code(() => pageDeps.parseArgs!(["abc", "--status"], ctx))).toBe("MISSING_VALUE");
    expect(code(() => pageDeps.parseArgs!(["abc", "--status", "LIVE"], ctx))).toBe("INVALID_VALUE");
    expect(((await pageDeps.parseArgs!(["abc", "--status", "draft"], ctx)) as any).status).toBe("DRAFT");
    expect(((await pageDeps.parseArgs!(["abc"], ctx)) as any).status).toBe("PUBLISHED");
  });
});

describe("pd history / lock subcommands", () => {
  test("history restore requires --version; only restore writes", async () => {
    const a = (await history.parseArgs!(["restore", "p1", "--version", "406403", "-y"], ctx)) as any;
    expect(a).toMatchObject({ action: "restore", pageId: "p1", version: 406403, yes: true });
    expect((history.writes as (x: any) => boolean)(a)).toBe(true);
    const l = (await history.parseArgs!(["list", "p1", "--limit", "5"], ctx)) as any;
    expect(l).toMatchObject({ action: "list", limit: 5, yes: false });
    expect((history.writes as (x: any) => boolean)(l)).toBe(false);
    expect(code(() => history.parseArgs!(["restore", "p1"], ctx))).toBe("MISSING_VERSION");
    expect(code(() => history.parseArgs!(["diff", "p1", "--from", "1"], ctx))).toBe("MISSING_VERSION_RANGE");
    expect(code(() => history.parseArgs!(["list", "p1", "--version", "1"], ctx))).toBe("UNKNOWN_FLAG");
    expect(code(() => history.parseArgs!([], ctx))).toBe("MISSING_ACTION");
    expect(code(() => history.parseArgs!(["restor", "p1"], ctx))).toBe("UNKNOWN_ACTION");
  });

  test("lock", async () => {
    expect(await lock.parseArgs!(["status"], ctx)).toEqual({ action: "status", pageId: null });
    const a = (await lock.parseArgs!(["acquire", "p1"], ctx)) as any;
    expect(a).toEqual({ action: "acquire", pageId: "p1" });
    expect((lock.writes as (x: any) => boolean)(a)).toBe(true);
    expect((lock.writes as (x: any) => boolean)({ action: "status", pageId: null })).toBe(false);
    expect(code(() => lock.parseArgs!(["release"], ctx))).toBe("MISSING_INPUT");
    expect(await lock.parseArgs!(["status", "p1"], ctx)).toEqual({ action: "status", pageId: "p1" });
    expect(code(() => lock.parseArgs!(["status", "p1", "p2"], ctx))).toBe("UNEXPECTED_ARGUMENT");
  });
});

describe("pd save / find", () => {
  test("save needs exactly one of --overlay / --config", async () => {
    expect(code(() => save.parseArgs!(["p1"], ctx))).toBe("INVALID_FLAGS");
    expect(code(() => save.parseArgs!(["p1", "--overlay", "a", "--config", "b"], ctx))).toBe("INVALID_FLAGS");
    expect(code(() => save.parseArgs!(["p1", "--overlay"], ctx))).toBe("MISSING_VALUE");
    const a = await save.parseArgs!(["p1", "--overlay", "o.json", "--dry-run"], ctx);
    expect(a).toEqual({
      pageId: "p1",
      overlayFile: "o.json",
      configFile: null,
      dryRun: true,
      overrides: { forceValidation: false, allowPublished: false, deprecatedForce: false },
      yes: false,
    });
    expect(save.writes).toBe(true);
  });

  test("PD-6: --force-validation and --allow-published are separate; --force aliases validation only", async () => {
    const o = async (...flags: string[]) => ((await save.parseArgs!(["p1", "--overlay", "o.json", ...flags], ctx)) as any).overrides;
    expect(await o("--force-validation")).toEqual({ forceValidation: true, allowPublished: false, deprecatedForce: false });
    expect(await o("--allow-published")).toEqual({ forceValidation: false, allowPublished: true, deprecatedForce: false });
    expect(await o("--force")).toEqual({ forceValidation: true, allowPublished: false, deprecatedForce: true });
    const p = (await publish.parseArgs!(["p1", "--force"], ctx)) as any;
    expect(p.overrides).toEqual({ forceValidation: true, allowPublished: false, deprecatedForce: true });
    // OTH-R8: --allow-published is not a restore flag; --acknowledge-unverified is a deprecated no-op (OTH-R2 verified).
    expect(code(() => history.parseArgs!(["restore", "p1", "--version", "1", "--allow-published"], ctx))).toBe("UNKNOWN_FLAG");
    const r = (await history.parseArgs!(["restore", "p1", "--version", "1", "--acknowledge-unverified"], ctx)) as any;
    expect(r.acknowledgeUnverified).toBe(true);
    expect(code(() => history.parseArgs!(["show", "p1", "--version", "1", "--allow-published"], ctx))).toBe("UNKNOWN_FLAG");
  });

  test("find limit bounds and list query", async () => {
    expect(code(() => find.parseArgs!(["x", "--limit", "5000"], ctx))).toBe("INVALID_VALUE");
    expect(((await find.parseArgs!(["list"], ctx)) as any).limit).toBeNull();
    expect(((await find.parseArgs!(["list", "--limit", "5"], ctx)) as any).limit).toBe(5);
    expect(code(() => find.parseArgs!(["list", "x"], ctx))).toBe("LIST_DOES_NOT_ACCEPT_QUERY");
    expect(((await find.parseArgs!(["list", "--components"], ctx)) as any).mode).toBe("browse-components");
    expect(((await find.parseArgs!(["pick", "a", "b"], ctx)) as any).query).toBe("a b");
  });
});
