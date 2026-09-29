// Envelope contract, success paths: read commands run against the real
// (sanitized) sems-dev wire captures in integrations/*/tests/fixtures/ through
// fakeFetch, and their `--llm` output must validate against EnvelopeSchema with
// ok:true, exit 0, `<ns>.<cmd>` schema, and `meta.env` only when env-aware.
// (Error/help paths: envelope-contract.test.ts.)
//
// KNOWN_VIOLATIONS: invocations that still break the contract, with the bug id
// that fixes them (Stage 4/6). They run as test.todo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  EnvelopeSchema,
  fakeFetch,
  loadDevCliOptions,
  repoRoot,
  runCliInProcess,
  withTempEnvConfig,
  type FakeFetch,
  type RecordedRequest,
  type TempEnvConfig,
} from "@belzabar/core/testing";
import type { NamespacedCliOptions } from "@belzabar/core";

const options: NamespacedCliOptions = await loadDevCliOptions();
const ROOT = repoRoot();
const AD = join(ROOT, "integrations/automation-designer/tests/fixtures");
const PD = join(ROOT, "integrations/page-designer/tests/fixtures/real");
const TW = join(ROOT, "integrations/teamwork/tests/fixtures/real");
const MG = join(ROOT, "integrations/migrations/tests/fixtures/real");

const ENV = "contract-sems";
const HOST = "https://contract-sems.test";
const JENKINS = "https://jenkins.example.com";
const JOB = `${JENKINS}/job/Deployments/job/Database/job/db-migration`;

const METHOD = "40b7959fb1dd8b4cf2ee9f5e54630ea8"; // real-v1 + real-v2 capture
const PAGE = "40d0b1551dd9950a968cafe4c9cc6159"; // "search-student"
const TASK = "25085246";

/** Envelope (by argv) → bug id + why it violates the contract today. */
const KNOWN_VIOLATIONS: Record<string, string> = {};

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/**
 * List endpoints were not captured; they are assembled from the real records:
 * AD `/automation/methods?categoryUuid=` = the real-v1 methods of that category,
 * PD `/pages?pageType=PAGE` = the real pages (without their configuration).
 */
function listFromCaptures(u: URL): Response | null {
  if (u.pathname === "/rest/api/automation/methods") {
    const cat = (u.searchParams.get("categoryUuid") ?? "").trim();
    const methodList = readdirSync(`${AD}/real-v1`)
      .filter((f) => f.endsWith(".v1.json"))
      .map((f) => readJson(`${AD}/real-v1/${f}`))
      .filter((m) => String(m.category?.uuid ?? "").trim() === cat);
    return jsonResponse({ methodList: Number(u.searchParams.get("offset") ?? 0) === 0 ? methodList : [] });
  }
  if (u.pathname === "/rest/api/pagedesigner/pages") {
    if (u.searchParams.get("pageType") !== "PAGE") return jsonResponse([]);
    const pages = readdirSync(PD)
      .filter((f) => /^[0-9a-f]{32}\.json$/.test(f))
      .map((f) => {
        const { configuration: _c, ...rest } = readJson(`${PD}/${f}`);
        return rest;
      });
    return jsonResponse(Number(u.searchParams.get("offset") ?? 0) === 0 ? pages : []);
  }
  return null;
}

/** Real capture for a request, or null (→ 404, recorded as a miss). */
function lookup(req: RecordedRequest): Response | null {
  const u = new URL(req.url);
  const path = u.pathname;
  const json = (file: string) =>
    existsSync(file) ? new Response(readFileSync(file), { headers: { "content-type": "application/json" } }) : null;
  let m: RegExpMatchArray | null;
  if (u.origin === HOST) {
    const list = listFromCaptures(u);
    if (list) return list;
    if ((m = path.match(/^\/rest\/api\/automation\/chain\/v2\/([0-9a-f]{32})$/))) return json(`${AD}/real-v2/${m[1]}.v2.json`);
    if (path === "/rest/api/automation/chain/category") {
      return json(`${AD}/categories/chain-category${u.searchParams.get("fetchSystemServices") === "true" ? "-system" : ""}.json`);
    }
    if ((m = path.match(/^\/rest\/api\/automation\/chain\/([0-9a-f]{32})$/))) return json(`${AD}/real-v1/${m[1]}.v1.json`);
    if ((m = path.match(/^\/rest\/api\/automations\/(\d+)$/))) return json(`${AD}/definitions/${m[1]}.json`);
    if (path === "/rest/api/automation/services") return json(`${AD}/categories/automation-services.json`);
    if ((m = path.match(/^\/rest\/api\/pagedesigner\/pages\/([0-9a-f]{32})$/))) return json(`${PD}/${m[1]}.json`);
  }
  if (u.origin === "https://projects.webintensive.com") {
    if (path === "/launchpad/v1/login.json") {
      return new Response("{}", { headers: { "content-type": "application/json", "set-cookie": "tw-auth=contract; Path=/" } });
    }
    if ((m = path.match(/^\/projects\/api\/v3\/tasks\/(\d+)\.json$/))) return json(`${TW}/task-${m[1]}.json`);
    if ((m = path.match(/^\/projects\/api\/v3\/tasks\/(\d+)\/comments\.json$/))) {
      return json(`${TW}/task-${m[1]}-comments-p${u.searchParams.get("page") ?? "1"}.json`);
    }
  }
  if (req.url.startsWith(JOB)) {
    const rest = req.url.slice(JOB.length);
    if (rest.startsWith("/api/json?tree=property")) return json(`${MG}/job-parameters.json`);
    if ((m = rest.match(/^\/(\d+)\/api\/json/))) return json(`${MG}/build-${m[1]}.json`);
  }
  return null;
}

interface Case {
  argv: string[];
  /** Expect meta.env (env-aware command). */
  envAware: boolean;
  /** The result is failure-shaped (then the envelope must be ok:false with data). */
  failed?: (data: any) => boolean;
}

const CASES: Case[] = [
  { argv: ["ad", "show", METHOD], envAware: true },
  { argv: ["ad", "fetch", METHOD], envAware: true },
  { argv: ["ad", "categories"], envAware: true },
  { argv: ["ad", "find", "student"], envAware: true },
  { argv: ["ad", "state", METHOD], envAware: true },
  { argv: ["ad", "outputs", METHOD], envAware: true },
  { argv: ["ad", "show-code", METHOD], envAware: true },
  { argv: ["pd", "show", PAGE], envAware: true },
  { argv: ["pd", "find", "search-student"], envAware: true },
  { argv: ["pd", "validate", PAGE], envAware: true, failed: (d) => (d?.errorCount ?? 0) > 0 },
  { argv: ["tw", "task", TASK], envAware: false },
  { argv: ["tw", "comments", TASK], envAware: false },
  { argv: ["migrate", "profiles"], envAware: false },
  { argv: ["migrate", "status", "1904"], envAware: false },
  { argv: ["envs"], envAware: false },
  { argv: ["config", "get"], envAware: false },
];

let ff: FakeFetch;
let cfg: TempEnvConfig;
let cwd: string;
let prevCwd: string;
const misses: string[] = [];
const realSpawn = Bun.spawn;
const realSpawnSync = Bun.spawnSync;

beforeAll(() => {
  ff = fakeFetch([
    {
      url: /.*/,
      response: (req: RecordedRequest) => {
        const hit = lookup(req);
        if (hit) return hit;
        misses.push(`${req.method} ${req.url}`);
        return new Response("not captured", { status: 404 });
      },
    },
  ]).install();
  cfg = withTempEnvConfig({
    envs: { [ENV]: { url: HOST } },
    teamwork: { email: "t@contract.test", password: btoa("x") },
    jenkins: { baseUrl: JENKINS, user: "u", password: btoa("x"), migrationJob: "Deployments/Database/db-migration" },
  });
  prevCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "belz-success-cwd-"));
  process.chdir(cwd);
  const blocked = (name: string) => () => {
    throw new Error(`envelope-success: ${name} is blocked`);
  };
  (Bun as any).spawn = blocked("Bun.spawn");
  (Bun as any).spawnSync = blocked("Bun.spawnSync");
});

afterAll(() => {
  ff.restore();
  cfg.restore();
  (Bun as any).spawn = realSpawn;
  (Bun as any).spawnSync = realSpawnSync;
  process.chdir(prevCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe("--llm success envelopes over real fixtures", () => {
  for (const c of CASES) {
    const key = c.argv.join(" ");
    const name = `belz ${key} --llm`;
    if (KNOWN_VIOLATIONS[key]) {
      test.todo(`${name}  [known: ${KNOWN_VIOLATIONS[key]}]`, () => {});
      continue;
    }
    test(name, async () => {
      const r = await runCliInProcess(options, [...c.argv, "--env", ENV]);
      const env = r.envelope;
      const problems: string[] = [];
      if (!env) problems.push("no envelope");
      else {
        const parsed = EnvelopeSchema.safeParse(env);
        if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `schema: ${i.path.join(".")}: ${i.message}`));
        const failed = c.failed?.(env.data) ?? false;
        if (failed) {
          if (env.ok) problems.push("failure-shaped result reported with ok:true");
          if (env.data === null) problems.push("ok:false without the result data");
          if (r.exitCode === 0) problems.push("failure-shaped result exited 0");
        } else {
          if (!env.ok) problems.push(`ok:false ${env.error?.code}: ${env.error?.message}`);
          if (r.exitCode !== 0) problems.push(`exit ${r.exitCode}`);
        }
        const [ns, cmd] = c.argv[0] === "envs" || c.argv[0] === "config" ? ["belz", c.argv[0]] : [c.argv[0], c.argv[1]];
        if (env.schema !== `${ns}.${cmd}`) problems.push(`schema ${env.schema} != ${ns}.${cmd}`);
        if (c.envAware && env.meta.env !== ENV) problems.push(`meta.env ${String(env.meta.env)} != ${ENV}`);
        if (!c.envAware && env.meta.env !== undefined) problems.push(`meta.env present on a non-env-aware command`);
        try {
          JSON.parse(r.stdout);
        } catch {
          problems.push("stdout is not one JSON document");
        }
      }
      expect({ argv: key, problems }).toEqual({ argv: key, problems: [] });
    }, 20_000);
  }
});

describe("harness sanity", () => {
  test("every request the success cases made was served from a real capture", () => {
    expect(misses).toEqual([]);
  });
});
