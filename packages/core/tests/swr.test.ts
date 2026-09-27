import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRefreshCommand, shouldRefresh } from "../src/swr";

const tmp = mkdtempSync(join(tmpdir(), "belz-swr-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildRefreshCommand (CORE-4 / AD-07)", () => {
  test("dev shape: re-runs bun with the script path", () => {
    const cmd = buildRefreshCommand(
      ["/usr/bin/bun", "/repo/cli/bin/cli.ts", "ad", "show", "X", "--env", "sems-dev"],
      "/usr/bin/bun",
    );
    expect(cmd).toEqual({
      bin: "/usr/bin/bun",
      args: ["/repo/cli/bin/cli.ts", "ad", "show", "X", "--env", "sems-dev", "--force"],
    });
  });

  test("compiled shape: argv[0] is 'bun' and argv[1] is /$bunfs — spawn execPath with argv.slice(2)", () => {
    const cmd = buildRefreshCommand(
      ["bun", "/$bunfs/root/belz", "pd", "show", "P", "--llm"],
      "/home/u/.local/bin/belz",
    );
    expect(cmd).toEqual({ bin: "/home/u/.local/bin/belz", args: ["pd", "show", "P", "--llm", "--force"] });
  });

  test("compiled shape on Windows (B:/~BUN/)", () => {
    const cmd = buildRefreshCommand(["bun", "B:/~BUN/root/belz.exe", "ad", "show", "X"], "C:\\belz.exe");
    expect(cmd).toEqual({ bin: "C:\\belz.exe", args: ["ad", "show", "X", "--force"] });
  });

  test("strips --open / -o and does not duplicate --force", () => {
    const cmd = buildRefreshCommand(
      ["bun", "/$bunfs/root/belz", "pd", "show", "P", "--open", "-o", "--force"],
      "/bin/belz",
    );
    expect(cmd!.args).toEqual(["pd", "show", "P", "--force"]);
  });

  test("returns null with no argv", () => {
    expect(buildRefreshCommand([], "/x")).toBeNull();
  });
});

describe("refresh lock", () => {
  test("lock key is normalized (padded uuid hits the same lock)", () => {
    const dir = join(tmp, "locks");
    mkdirSync(join(dir, ".refresh"), { recursive: true });
    writeFileSync(join(dir, ".refresh", "abc.lock"), String(Date.now()));
    expect(shouldRefresh(dir, "  abc  ")).toBe(false);
    expect(shouldRefresh(dir, "other")).toBe(true);
  });
});
