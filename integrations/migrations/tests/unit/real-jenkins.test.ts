// Jenkins client + console parser against real (sanitized) captures of the
// db-migration job. Fixtures: tests/fixtures/real/ (see manifest.json; host
// rewritten to jenkins.example.com by scripts/fixtures/capture.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fakeFetch, fixture, respond, type FakeFetch } from "@belzabar/core/testing";
import { getBuild, getConsoleChunk, getJobParameters, groupProfiles, parseJenkinsConsole, type JenkinsAuth } from "../../lib";

const FIX = `${import.meta.dir}/../fixtures/real`;
const auth: JenkinsAuth = {
  baseUrl: "https://jenkins.example.com",
  user: "u",
  password: "p",
  job: "Deployments/Expertly/Database/expertly.db-migration",
};
const JOB = "https://jenkins.example.com/job/Deployments/job/Expertly/job/Database/job/expertly.db-migration";
const consoleText = readFileSync(`${FIX}/build-1904-console-0.txt`, "utf8");

let ff: FakeFetch | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
});

describe("real Jenkins wire", () => {
  test("getJobParameters → PROFILE_NAME choices group by client (SEMS has devsems_qasems)", async () => {
    ff = fakeFetch([{ method: "GET", url: /\/api\/json\?tree=property/, response: fixture(`${FIX}/job-parameters.json`) }]).install();
    const params = await getJobParameters(auth);
    expect(ff.requests[0]!.url.startsWith(`${JOB}/api/json?tree=`)).toBe(true);
    expect(ff.requests[0]!.headers["authorization"]).toBe(`Basic ${btoa("u:p")}`);
    expect(params.map((p) => p.name)).toEqual([
      "CLIENT", "PROFILE_NAME", "MIGRATE_TYPE", "IDS", "MIGRATION_ID",
      "ASYNC_MIGRATION", "MIGRATE_DEPENDENT", "DEVOPS_TAG", "DRY_RUN", "AUTO_APPROVE",
    ]);
    const profiles = params.find((p) => p.name === "PROFILE_NAME")!.choices!;
    expect(profiles.length).toBeGreaterThan(50);
    const groups = groupProfiles(profiles);
    expect(groups.find((g) => g.client === "SEMS")?.profiles).toContain("devsems_qasems");
    // Choices interleave "--- CLIENT ---" dividers; every other choice lands in a group.
    const dividers = profiles.filter((c) => /^\s*-{3,}.*-{3,}\s*$/.test(c));
    expect(dividers).toContain("--- SEMS ---");
    expect(groups.flatMap((g) => g.profiles).length).toBe(profiles.length - dividers.length);
  });

  test("getBuild(1904) returns the finished build record with its parameters", async () => {
    ff = fakeFetch({ [`GET ${JOB}/1904/api/json`]: fixture(`${FIX}/build-1904.json`) }).install();
    const b = (await getBuild(auth, 1904)) as any;
    expect(b.number).toBe(1904);
    expect(b.result).toBe("SUCCESS");
    expect(b.building).toBe(false);
    const params = b.actions.find((a: any) => a.parameters).parameters;
    expect(params.find((p: any) => p.name === "PROFILE_NAME").value).toBe("devsems_qasems");
  });

  test("getConsoleChunk reads X-Text-Size / X-More-Data; parser extracts the run", async () => {
    ff = fakeFetch([{
      method: "GET",
      url: `${JOB}/1904/logText/progressiveText?start=0`,
      response: respond({ text: consoleText, headers: { "X-Text-Size": "27107" } }),
    }]).install();
    const chunk = await getConsoleChunk(auth, 1904, 0);
    expect(chunk.nextOffset).toBe(27107);
    expect(chunk.hasMore).toBe(false);

    const parsed = parseJenkinsConsole(chunk.text);
    expect(parsed.cleanedOutput).not.toContain("ha:////");
    expect(parsed.cleanedOutput).not.toContain("\x1b[");
    expect(parsed.finishedResult).toBe("SUCCESS");
    expect(parsed.successDetected).toBe(true);
    expect(parsed.failureDetected).toBe(false);
    expect(parsed.sourceProfile).toBe("devsems_qasems");
    expect(parsed.reportSummary).toMatchObject({ migrationStatus: "COMPLETED", entityCount: 2, failedCount: 0 });
  });
});
