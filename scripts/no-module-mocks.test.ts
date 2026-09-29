import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

// Bun's mock.module is process-wide: a module mock in one test file replaces
// the module for every file that runs after it, so results depend on file order
// (CI saw a fake publishDraft in the publish tests). Fake the network with
// fakeFetch from @belzabar/core/testing instead.
describe("test files", () => {
  test("never use mock.module", () => {
    const offenders: string[] = [];
    for (const file of new Bun.Glob("{packages,apps,integrations,scripts}/**/*.test.ts").scanSync(".")) {
      if (file.includes("node_modules") || file.endsWith("no-module-mocks.test.ts")) continue;
      if (/\bmock\.module\s*\(/.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
