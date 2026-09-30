// `migrate run` outcome: a build can finish SUCCESS and migrate nothing (the
// script skips a method whose version is the same on source and target). The
// same-version console is derived from the sanitized build-1904 capture.
// Also: the target env's cache is evicted after a followed, real build.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fakeFetch, type FakeFetch, fixture, respond, runCommand, type TempEnvConfig, withTempEnvConfig } from "@belzabar/core/testing";
import { Cache } from "@belzabar/core";
import { METHOD_CACHE_DIR } from "@belzabar/core/platform";
import { migrationOutcome, parseConsoleWarnings, parseJenkinsConsole } from "../../lib";
import runCmdModule from "../../commands/run/index";

const runCmd = { ...runCmdModule, envAware: false };
const FIX = `${import.meta.dir}/../fixtures/real`;
const REAL_CONSOLE = readFileSync(`${FIX}/build-1904-console-0.txt`, "utf8");
const UUID = "4d075e621c93206fb95d84795fc05e00";

/** build 1904's console as a same-version skip: a WARNING line, and every report row UNCHANGED. */
const SAME_VERSION_CONSOLE = REAL_CONSOLE
  .replace(
    /(=> AD :: Migrating IDs: [^\n]*\n)/,
    `$1d3811d1f-0b74-445c-b60a-197a12387137 => AD :: WARNING: Method ${UUID} has same version (1) on source and target\n`,
  )
  .replaceAll('"entityMigrationStatus": "COMPLETED"', '"entityMigrationStatus": "UNCHANGED"')
  .replaceAll('"identical": true', '"identical": false');

describe("console warnings", () => {
  test("a same-version notice becomes parsed.skipped; other WARNING lines parsed.warnings", () => {
    const { skipped, warnings } = parseConsoleWarnings(
      "x => AD :: WARNING: Method ABCDEF0123456789abcdef0123456789 has same version (3) on source and target\n" +
        "x => AD :: WARNING: something else happened\n",
    );
    expect(skipped).toEqual([{ id: "abcdef0123456789abcdef0123456789", reason: "same-version", version: 3 }]);
    expect(warnings).toEqual(["something else happened"]);
  });

  test("the real capture has no skips; its report keeps per-entity rows", () => {
    const parsed = parseJenkinsConsole(REAL_CONSOLE);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.reportSummary).toMatchObject({ completedCount: 2, unchangedCount: 0 });
    expect(parsed.reportSummary?.entities[0]).toEqual({ id: UUID, name: "callback.on.user.created", status: "COMPLETED", identical: true });
    expect(migrationOutcome([UUID], parsed)).toEqual({ outcome: "MIGRATED", unchanged: [] });
  });

  test("the same-version console: skipped, UNCHANGED counted, NOTHING_MIGRATED", () => {
    const parsed = parseJenkinsConsole(SAME_VERSION_CONSOLE);
    expect(parsed.skipped).toEqual([{ id: UUID, reason: "same-version", version: 1 }]);
    expect(parsed.reportSummary).toMatchObject({ completedCount: 0, unchangedCount: 2, entityCount: 2 });
    expect(migrationOutcome([UUID], parsed).outcome).toBe("NOTHING_MIGRATED");
  });

  test("one of two ids skipped → PARTIAL", () => {
    const other = "0123456789abcdef0123456789abcdef";
    const parsed = parseJenkinsConsole(REAL_CONSOLE.replace(
      /(=> AD :: Migrating IDs: [^\n]*\n)/,
      `$1r => AD :: WARNING: Method ${other} has same version (2) on source and target\n`,
    ));
    expect(migrationOutcome([UUID, other], parsed)).toEqual({ outcome: "PARTIAL", unchanged: [other] });
  });
});

describe("migrate run over a followed build", () => {
  const JENKINS = { baseUrl: "https://jk.test", user: "u", password: "p", passwordEncoding: "plain" as const, migrationJob: "A/b" };
  const JOB = "https://jk.test/job/A/job/b";
  let cfg: TempEnvConfig | null = null;
  let ff: FakeFetch | null = null;
  afterEach(() => {
    ff?.restore();
    ff = null;
    cfg?.restore();
    cfg = null;
  });

  function build(consoleText: string) {
    cfg = withTempEnvConfig({ envs: {}, jenkins: { ...JENKINS, profileEnvs: { devacme: "acme-dev", qaacme: "acme-qa" } } });
    ff = fakeFetch([
      { method: "GET", url: /\/api\/json\?tree=property/, response: fixture(`${FIX}/job-parameters.json`) },
      { method: "GET", url: "https://jk.test/crumbIssuer/api/json", response: respond({ status: 404 }) },
      { method: "POST", url: `${JOB}/buildWithParameters`, response: respond({ status: 201, headers: { location: "https://jk.test/queue/item/7/" } }) },
      { method: "GET", url: "https://jk.test/queue/item/7/api/json", response: { id: 7, executable: { number: 42, url: `${JOB}/42/` } } },
      { method: "GET", url: `${JOB}/42/logText/progressiveText?start=0`, response: respond({ text: consoleText, headers: { "X-Text-Size": String(consoleText.length) } }) },
      { method: "GET", url: /\/42\/logText\/progressiveText\?start=[1-9]/, response: respond({ text: "", headers: { "X-Text-Size": String(consoleText.length) } }) },
      { method: "GET", url: `${JOB}/42/api/json`, response: { number: 42, building: false, result: "SUCCESS", duration: 1000, url: `${JOB}/42/` } },
    ]).install();
  }
  const argv = ["--profile", "devacme_qaacme", "--client", "ACME", "--module", "AD_Method", "--ids", UUID, "--yes"];

  test("same version: ok (the build succeeded) with data.outcome NOTHING_MIGRATED and a warning", async () => {
    build(SAME_VERSION_CONSOLE);
    const r = await runCommand(runCmd, argv);
    expect(r.envelope?.ok).toBe(true);
    const data = r.envelope?.data as { result: string; outcome: string; unchanged: string[]; parsed: { skipped: unknown[] } };
    expect(data.result).toBe("SUCCESS");
    expect(data.outcome).toBe("NOTHING_MIGRATED");
    expect(data.unchanged).toEqual([UUID, "442773fbf36b60f333ccaefb6c771af0"]);
    const warnings = (r.envelope?.meta?.warnings ?? []) as string[];
    expect(warnings.some((w) => w.includes(`callback.on.user.created ${UUID}: skipped, same version 1`))).toBe(true);
  });

  test("same version with --strict → MIGRATE_NOTHING_MIGRATED, no do-not-rerun hint", async () => {
    build(SAME_VERSION_CONSOLE);
    const r = await runCommand(runCmd, [...argv, "--strict"]);
    const err = r.envelope?.error;
    expect(err?.code).toBe("MIGRATE_NOTHING_MIGRATED");
    expect(err?.message).not.toContain("do NOT re-run");
    expect(err?.details).toMatchObject({ outcome: "NOTHING_MIGRATED", buildTriggered: true, buildNumber: 42 });
  });

  test("a real migration: outcome MIGRATED; --strict passes", async () => {
    build(REAL_CONSOLE);
    const r = await runCommand(runCmd, [...argv, "--strict"]);
    expect(r.envelope?.ok).toBe(true);
    expect((r.envelope?.data as { outcome: string }).outcome).toBe("MIGRATED");
  });

  const methods = new Cache<unknown>({ dir: METHOD_CACHE_DIR, ttlMs: null });

  test("the target env's cached copy of a migrated method is dropped (data.cacheInvalidated)", async () => {
    build(REAL_CONSOLE);
    await methods.save(UUID, { stale: true }, "acme-qa");
    await methods.save(UUID, { source: true }, "acme-dev");
    const r = await runCommand(runCmd, argv);
    expect((r.envelope?.data as { cacheInvalidated: unknown }).cacheInvalidated).toEqual({ env: "acme-qa", ids: [UUID] });
    expect(await methods.load(UUID, "acme-qa")).toBeNull();
    expect(await methods.load(UUID, "acme-dev")).toEqual({ source: true });
  });

  test("a dry run leaves the target cache alone", async () => {
    build(REAL_CONSOLE);
    await methods.save(UUID, { kept: true }, "acme-qa");
    const r = await runCommand(runCmd, [...argv, "--dry-run"]);
    expect((r.envelope?.data as { cacheInvalidated?: unknown }).cacheInvalidated).toBeUndefined();
    expect(await methods.load(UUID, "acme-qa")).toEqual({ kept: true });
  });
});
