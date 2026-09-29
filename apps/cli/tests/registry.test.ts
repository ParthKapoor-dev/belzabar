// Static registries: every `commands/<name>/` folder must be registered,
// with non-empty help.txt + desc.txt, and registries stay sorted so the
// hand-maintained files and `belz --help-full` are deterministic.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { repoRoot } from "@belzabar/core/testing";
import { REGISTRIES, buildCliOptions, buildHelpFull } from "../bin/options";

const root = repoRoot();

function commandDirs(owner: string): string[] {
  const dir = join(root, owner, "commands");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

describe("static command registries", () => {
  for (const [owner, registry] of Object.entries(REGISTRIES)) {
    describe(owner, () => {
      test("lists exactly the commands/* folders", () => {
        expect(Object.keys(registry).sort()).toEqual(commandDirs(owner));
      });

      test("is written in sorted order", () => {
        const keys = Object.keys(registry);
        expect(keys).toEqual([...keys].sort());
      });

      test("every command has index.ts, help.txt and desc.txt matching the registry", () => {
        for (const [name, entry] of Object.entries(registry)) {
          const dir = join(root, owner, "commands", name);
          expect(existsSync(join(dir, "index.ts"))).toBe(true);
          const help = readFileSync(join(dir, "help.txt"), "utf8");
          const desc = readFileSync(join(dir, "desc.txt"), "utf8");
          expect(help.trim().length).toBeGreaterThan(0);
          expect(desc.trim().length).toBeGreaterThan(0);
          expect(entry.help).toBe(help);
          expect(entry.desc).toBe(desc);
          // Same resolution as the runner: default export, else the namespace itself.
          const mod = entry.module as { default?: { execute?: unknown }; execute?: unknown };
          expect(typeof (mod.default ?? mod).execute).toBe("function");
        }
      });
    });
  }

  test("--help-full is deterministic and includes every desc.txt", () => {
    const text = buildHelpFull();
    expect(buildHelpFull()).toBe(text);
    for (const registry of Object.values(REGISTRIES)) {
      for (const entry of Object.values(registry)) expect(text).toContain(entry.desc.trimEnd());
    }
  });

  test("CLI options route every registered command", () => {
    const opts = buildCliOptions();
    const routed = new Set([
      ...Object.keys(opts.topLevel),
      ...Object.values(opts.namespaces).flatMap((ns) => Object.keys(ns.commands ?? {})),
      ...Object.entries(opts.namespaces).filter(([, ns]) => ns.command).map(([k]) => k),
    ]);
    const total = Object.values(REGISTRIES).reduce((n, r) => n + Object.keys(r).length, 0);
    expect(routed.size).toBeLessThanOrEqual(total);
    for (const name of Object.keys(REGISTRIES["apps/cli"]!)) expect(routed.has(name)).toBe(true);
  });
});
