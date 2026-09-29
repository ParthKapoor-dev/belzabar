// `belz --help-full` is the runtime agents' command reference, so it must be
// byte-for-byte deterministic: fixed section order, sorted commands, and no
// content that depends on the environment, the clock, the locale or the build.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { EnvelopeSchema } from "@belzabar/core/testing";
import { BUILD, buildHelpFull, REGISTRIES } from "../bin/options";

const CLI = resolve(import.meta.dir, "../bin/cli.ts");

function runHelpFull(env: Record<string, string>, cwd: string, args: string[] = ["--help-full"]): { out: string; code: number } {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: proc.stdout.toString(), code: proc.exitCode ?? -1 };
}

describe("belz --help-full", () => {
  test("is byte-identical across runs with different env, locale, timezone and cwd", () => {
    const a = runHelpFull({ BELZ_HOME: mkdtempSync(join(tmpdir(), "hf-a-")), TZ: "UTC", LANG: "C" }, tmpdir());
    const b = runHelpFull(
      { BELZ_HOME: mkdtempSync(join(tmpdir(), "hf-b-")), TZ: "Asia/Kolkata", LANG: "tr_TR.UTF-8", BELZ_VERBOSE: "1", NO_COLOR: "1" },
      resolve(import.meta.dir, ".."),
    );
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(b.out).toBe(a.out);
    expect(a.out).toBe(buildHelpFull() + "\n");
  }, 30_000);

  test("carries no build identity, build date or ANSI escapes", () => {
    const text = buildHelpFull();
    if (BUILD.sha !== "unknown") expect(text).not.toContain(BUILD.sha);
    expect(text).not.toContain(BUILD.builtAt);
    expect(text).not.toMatch(/\x1b\[/);
  });

  test("lists each section's commands in sorted order", () => {
    const text = buildHelpFull()!;
    for (const registry of Object.values(REGISTRIES)) {
      const positions = Object.keys(registry)
        .sort()
        .map((name) => text.indexOf(registry[name]!.desc.trimEnd()));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    }
  });

  test("--help-full --llm is one belz.help envelope carrying the text", () => {
    const home = mkdtempSync(join(tmpdir(), "hf-llm-"));
    for (const args of [["--help-full", "--llm"], ["--llm", "--help-full"]]) {
      const r = runHelpFull({ BELZ_HOME: home }, tmpdir(), args);
      expect(r.code).toBe(0);
      const env = EnvelopeSchema.parse(JSON.parse(r.out));
      expect(env.schema).toBe("belz.help");
      expect(env.ok).toBe(true);
      expect((env.data as { text: string }).text).toBe(buildHelpFull()!);
    }
  }, 30_000);

  test("--help-full after `--` belongs to the command, not the runner", () => {
    const r = runHelpFull({ BELZ_HOME: mkdtempSync(join(tmpdir(), "hf-dd-")) }, tmpdir(), ["ad", "show", "--", "--help-full", "--llm"]);
    expect(r.out).not.toContain("NOTE FOR LLM AGENTS");
  }, 30_000);

  test("--help-full <module> prints one section; --index one line per command", () => {
    const full = buildHelpFull()!;
    const ad = buildHelpFull({ namespace: "ad" })!;
    expect(ad).toContain("belz ad <cmd>");
    expect(ad).not.toContain("belz pd <cmd>");
    expect(ad.length).toBeLessThan(full.length);
    const index = buildHelpFull({ index: true })!;
    expect(index.length).toBeLessThan(full.length / 3);
    for (const name of Object.keys(REGISTRIES["integrations/automation-designer"]!)) expect(index).toContain(`belz ad ${name}  :->  `);
    expect(buildHelpFull({ namespace: "nope" })).toBeNull();
    const home = mkdtempSync(join(tmpdir(), "hf-ns-"));
    const r = runHelpFull({ BELZ_HOME: home }, tmpdir(), ["--help-full", "pd", "--index"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(buildHelpFull({ namespace: "pd", index: true }) + "\n");
    const bad = runHelpFull({ BELZ_HOME: home }, tmpdir(), ["--help-full", "nope", "--llm"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).error.code).toBe("INVALID_ARGS");
  }, 30_000);
});
