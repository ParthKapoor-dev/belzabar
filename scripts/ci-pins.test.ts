// Every workflow (and cloud/publish.sh) builds/tests with the same
// pinned Bun, and installs strictly from the committed lockfile.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const workflowFiles = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
const read = (p: string) => readFileSync(p, "utf8");
const ciPin = read(join(WORKFLOWS, "ci.yml")).match(/bun-version:\s*(\S+)/)![1]!;

describe("Bun pins and lockfile", () => {
  test("CI pins an exact Bun version", () => {
    expect(ciPin).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const f of workflowFiles) {
    test(`${f}: setup-bun uses the CI pin; installs are frozen and script-free`, () => {
      const text = read(join(WORKFLOWS, f));
      for (const m of text.matchAll(/bun-version:\s*(\S+)/g)) expect(m[1]).toBe(ciPin);
      for (const line of text.split("\n").filter((l) => /\bbun install\b/.test(l))) {
        expect(line).toContain("--frozen-lockfile");
        expect(line).toContain("--ignore-scripts");
      }
    });
  }

  test("cloud/publish.sh: frozen install with no fallback, same Bun as CI", () => {
    const sh = read(join(ROOT, "cloud", "publish.sh"));
    const installs = sh.split("\n").filter((l) => /^\s*bun install\b/.test(l));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) {
      expect(l).toContain("--frozen-lockfile");
      expect(l).not.toContain("||");
    }
    expect(sh).toContain(`EXPECTED_BUN="${ciPin}"`);
  });
});
