// `belz update` must find the install scripts in both the current layout
// (apps/cli/scripts) and the pre-restructure one (cli/scripts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installScriptDir } from "../commands/update/index";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function checkout(...scriptDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "belz-update-"));
  dirs.push(root);
  for (const d of scriptDirs) mkdirSync(join(root, d), { recursive: true });
  return root;
}

describe("installScriptDir", () => {
  test("prefers apps/cli/scripts", () => {
    const root = checkout("apps/cli/scripts", "cli/scripts");
    expect(installScriptDir(root)).toBe(join(root, "apps", "cli", "scripts"));
  });

  test("falls back to the old cli/scripts layout", () => {
    const root = checkout("cli/scripts");
    expect(installScriptDir(root)).toBe(join(root, "cli", "scripts"));
  });
});
