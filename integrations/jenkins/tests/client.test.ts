// Jenkins adapter over core/http: short coded errors (no HTML / crumb in
// messages), build 404 → "Build #n not found", queue deadline, crumb errors
// (MG-5/7/8, F28).
import { afterEach, describe, expect, test } from "bun:test";
import { CliError } from "@belzabar/core";
import { fakeFetch, respond, type FakeFetch } from "@belzabar/core/testing";
import { assertJenkinsAuth, buildHeaders, fetchCrumb, getBuild, getConsoleChunk, resolveQueueItem, triggerBuild, type JenkinsAuth } from "../lib";

const auth: JenkinsAuth = { baseUrl: "https://jenkins.test", user: "u", password: "p", job: "A/b" };
const JOB = "https://jenkins.test/job/A/job/b";
const HTML_404 = `<html><head><title>Error 404 Not Found</title></head><body>
<script>crumb.init("Jenkins-Crumb", "deadbeefcafe0123456789");</script>${"x".repeat(90_000)}</body></html>`;

let ff: FakeFetch | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
});

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected rejection");
}

describe("jenkins client", () => {
  test("build 404 → 'Build #n not found', no HTML or crumb anywhere", async () => {
    ff = fakeFetch({ [`GET ${JOB}/99999999/api/json`]: respond({ status: 404, headers: { "content-type": "text/html" }, text: HTML_404 }) }).install();
    const e = await caught(getBuild(auth, 99999999));
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe("MIGRATE_JENKINS_BUILD_NOT_FOUND");
    expect(e.message).toBe("Build #99999999 not found");
    expect(JSON.stringify(e.details)).not.toContain("deadbeef");
  });

  test("console 5xx → short message with the page title only", async () => {
    ff = fakeFetch([{ url: /progressiveText/, response: respond({ status: 500, headers: { "content-type": "text/html" }, text: HTML_404.replace("Error 404 Not Found", "Oops") }) }]).install();
    const e = await caught(getConsoleChunk(auth, 5, 0));
    expect(e.code).toBe("MIGRATE_JENKINS_CONSOLE_READ_FAILED");
    expect(e.message).toBe("Failed to fetch console of build #5 (HTTP 500): HTML page: Oops");
    expect(e.message).not.toContain("deadbeef");
  });

  test("requests go through the shared transport with basic auth", async () => {
    ff = fakeFetch({ [`GET ${JOB}/7/api/json`]: { number: 7, building: false } }).install();
    const b = await getBuild(auth, 7);
    expect(b.number).toBe(7);
    expect(ff.requests[0]!.headers["authorization"]).toBe(`Basic ${btoa("u:p")}`);
    expect(ff.requests[0]!.wireUrl).toContain("127.0.0.2"); // IPv4-pinned
  });

  test("queue poll gives up at the deadline with JENKINS_QUEUE_TIMEOUT", async () => {
    ff = fakeFetch({ "GET https://jenkins.test/queue/item/1/api/json": { id: 1, why: "Waiting for next available executor" } }).install();
    const e = await caught(resolveQueueItem(auth, "https://jenkins.test/queue/item/1/", { pollMs: 5, timeoutMs: 30 }));
    expect(e.code).toBe("JENKINS_QUEUE_TIMEOUT");
    expect(e.message).toContain("Waiting for next available executor");
    expect(ff.requests.length).toBeGreaterThan(1);
  });

  test("queue resolves when an executor is assigned", async () => {
    ff = fakeFetch([
      { url: /queue\/item\/2/, response: { id: 2, why: "wait" }, once: true },
      { url: /queue\/item\/2/, response: { id: 2, executable: { number: 42, url: "u" } } },
    ]).install();
    const item = await resolveQueueItem(auth, "https://jenkins.test/queue/item/2/", { pollMs: 1 });
    expect(item.executable?.number).toBe(42);
  });

  test("crumb 403 → MIGRATE_JENKINS_CRUMB_FAILED CliError (was UNHANDLED)", async () => {
    const other = { ...auth, user: "crumb-403" };
    ff = fakeFetch({ "GET https://jenkins.test/crumbIssuer/api/json": respond({ status: 403, text: "<html><title>Access denied</title></html>" }) }).install();
    const e = await caught(fetchCrumb(other));
    expect(e).toBeInstanceOf(CliError);
    expect(e.code).toBe("MIGRATE_JENKINS_CRUMB_FAILED");
    expect(e.message).toContain("HTTP 403");
  });

  test("trigger failure message has no HTML body", async () => {
    const other = { ...auth, user: "trigger" };
    ff = fakeFetch([
      { url: "https://jenkins.test/crumbIssuer/api/json", response: { crumb: "c0ffee", crumbRequestField: "Jenkins-Crumb" } },
      { method: "POST", url: `${JOB}/buildWithParameters`, response: respond({ status: 500, headers: { "content-type": "text/html" }, text: HTML_404.replace("Error 404 Not Found", "Server Error") }) },
    ]).install();
    const e = await caught(
      triggerBuild(other, { client: "ACME", profile: "p", migrateType: "PD", ids: ["1"], asyncMigration: "N", migrateDependent: "N" }),
    );
    expect(e.code).toBe("MIGRATE_JENKINS_TRIGGER_FAILED");
    expect(e.message).toBe("Failed to trigger Jenkins build (HTTP 500): HTML page: Server Error");
    expect(JSON.stringify(e.details)).not.toContain("c0ffee");
    expect(ff.calls("POST")[0]!.headers["jenkins-crumb"]).toBe("c0ffee");
  });

  test("basic auth encodes UTF-8 credentials (btoa threw on non-Latin-1)", () => {
    const h = buildHeaders({ ...auth, user: "jö", password: "pässwörd€" });
    const decoded = Buffer.from(h.Authorization!.replace(/^Basic /, ""), "base64").toString("utf8");
    expect(decoded).toBe("jö:pässwörd€");
    expect(buildHeaders(auth).Authorization).toBe(`Basic ${btoa("u:p")}`);
  });

  test("assertJenkinsAuth requires the migration job (no built-in default)", () => {
    expect(assertJenkinsAuth({ baseUrl: "https://j.test/", user: "u", password: "p", migrationJob: "Jobs/db-migration" })).toEqual({
      baseUrl: "https://j.test", user: "u", password: "p", job: "Jobs/db-migration",
    });
    try {
      assertJenkinsAuth({ baseUrl: "https://j.test/", user: "u", password: "p" });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe("MIGRATE_JENKINS_CONFIG_MISSING");
      expect((e as CliError).details).toEqual({ missing: ["migrationJob"] });
    }
  });
});
