// MG-4: the profile cache has a TTL, and a miss against the cache re-fetches once.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fakeFetch, type FakeFetch } from "@belzabar/core/testing";
import { discoverProfiles, MIGRATION_PROFILES_CACHE_PATH, resolveClientForProfile, type JenkinsAuth } from "../../lib";

const auth: JenkinsAuth = { baseUrl: "https://jenkins.test", user: "u", password: "p", job: "A/b" };
const params = (choices: string[]) => ({
  property: [{ parameterDefinitions: [{ name: "PROFILE_NAME", type: "ChoiceParameterDefinition", choices }] }],
});

let ff: FakeFetch | null = null;
afterEach(() => {
  ff?.restore();
  ff = null;
  rmSync(MIGRATION_PROFILES_CACHE_PATH, { force: true });
});

function writeCache(fetchedAt: string, profiles: string[]) {
  mkdirSync(dirname(MIGRATION_PROFILES_CACHE_PATH), { recursive: true });
  writeFileSync(MIGRATION_PROFILES_CACHE_PATH, JSON.stringify({ fetchedAt, groups: [{ client: "ACME", profiles }] }));
}

describe("profile cache", () => {
  test("a fresh cache is used without a request", async () => {
    writeCache(new Date().toISOString(), ["a_b"]);
    ff = fakeFetch([]).install();
    const r = await discoverProfiles(auth);
    expect(r.source).toBe("cache");
    expect(ff.requests.length).toBe(0);
  });

  test("an expired cache is re-fetched", async () => {
    writeCache("2026-07-13T00:00:00.000Z", ["old_one"]);
    ff = fakeFetch([{ url: /api\/json\?tree=property/, response: params(["--- ACME ---", "new_one"]) }]).install();
    const r = await discoverProfiles(auth);
    expect(r.source).toBe("live");
    expect(r.flat).toEqual(["new_one"]);
  });

  test("a profile missing from a fresh cache triggers one refresh", async () => {
    writeCache(new Date().toISOString(), ["a_b"]);
    ff = fakeFetch([{ url: /api\/json\?tree=property/, response: params(["--- ACME ---", "a_b", "added_later"]) }]).install();
    const { client, resolution } = await resolveClientForProfile(auth, "added_later");
    expect(client).toBe("ACME");
    expect(resolution.source).toBe("live");
    expect(ff.requests.length).toBe(1);
  });
});
