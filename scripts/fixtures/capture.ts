#!/usr/bin/env bun
// Read-only wire-fixture capture tool.
//
//   bun scripts/fixtures/capture.ts <target> [args]
//
// Targets:
//   ad-v1                      V1 chain bodies for every uuid in real-v1/ (refresh)
//   ad-v2                      V2 chain bodies for every uuid in real-v1/
//   ad-defs [n=10]             /automations/{id} for the automationIds used by n real-v1 methods
//   ad-categories              /chain/category + /automation/services
//   ad-notfound                V1 + V2 GET of a nonexistent uuid (200 empty body)
//   pd <id,id,...>             PD pages/components by id
//   pd-search <name>           list PD rows by name (prints only, writes nothing)
//   pd-list <PAGE|COMPONENT> [n]  list n DRAFT rows (prints only)
//   tw <taskId> [pageSize=5]   Teamwork task + all comment pages (small pageSize → multi-page fixture)
//   jenkins                    job parameters (profiles), latest finished build, console chunk
//   resanitize <dir>           offline: re-run sanitize() over every *.json under <dir> (rewrites only changed files)
//
// Safety: sems-dev only (Config.setActiveEnv("sems-dev")), GET only, and every
// body goes through sanitize() before touching disk. Each fixture dir gets a
// manifest.json: { file, source, env, capturedAt, endpoint, status, bytes }.

import { mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { apiFetch, Config } from "@belzabar/core";
import { assertCaptureEnv, assertReadOnly, CAPTURE_ENV } from "./guard";
import { sanitize, sanitizeText } from "./sanitize";

const ROOT = resolve(import.meta.dir, "../..");
const AD_FIX = join(ROOT, "integrations/automation-designer/tests/fixtures");
const PD_FIX = join(ROOT, "integrations/page-designer/tests/fixtures/real");
const TW_FIX = join(ROOT, "integrations/teamwork/tests/fixtures/real");
const MG_FIX = join(ROOT, "integrations/migrations/tests/fixtures/real");

assertCaptureEnv(CAPTURE_ENV);
Config.setActiveEnv(CAPTURE_ENV);
assertCaptureEnv(Config.activeEnv.name);

// ── HTTP (GET only) ─────────────────────────────────────────────────────────

interface Captured { status: number; contentType: string; text: string; headers: Headers }

async function expertlyGet(path: string): Promise<Captured> {
  assertReadOnly("GET");
  assertCaptureEnv(Config.activeEnv.name);
  const res = await apiFetch(path, { method: "GET", authMode: "Bearer" });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text(), headers: res.headers };
}

// ── Manifest / write ────────────────────────────────────────────────────────

interface ManifestEntry {
  file: string;
  source: Record<string, unknown>;
  env: string;
  capturedAt: string;
  endpoint: string;
  status: number;
  bytes: number;
  note?: string;
}

function writeFixture(dir: string, file: string, body: unknown, entry: Omit<ManifestEntry, "file" | "env" | "capturedAt" | "bytes">): number {
  mkdirSync(dir, { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(sanitize(body), null, 2) + "\n";
  const clean = typeof body === "string" ? sanitizeText(body) : text;
  writeFileSync(join(dir, file), clean);
  const manifestPath = join(dir, "manifest.json");
  const manifest: ManifestEntry[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  const bytes = Buffer.byteLength(clean);
  const next: ManifestEntry = { file, env: CAPTURE_ENV, capturedAt: new Date().toISOString(), bytes, ...entry };
  const i = manifest.findIndex((m) => m.file === file);
  if (i >= 0) manifest[i] = next; else manifest.push(next);
  manifest.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  ${file}  ${(bytes / 1024).toFixed(1)} KB  (${entry.status})`);
  return bytes;
}

function realV1Uuids(): string[] {
  return readdirSync(join(AD_FIX, "real-v1")).filter((f) => f.endsWith(".v1.json")).map((f) => f.slice(0, -".v1.json".length)).sort();
}

function parseJson(c: Captured, what: string): unknown {
  if (c.status !== 200) throw new Error(`${what}: HTTP ${c.status}: ${c.text.slice(0, 200)}`);
  if (!c.text) throw new Error(`${what}: empty body`);
  return JSON.parse(c.text);
}

// ── AD ──────────────────────────────────────────────────────────────────────

async function adChains(version: "v1" | "v2") {
  const dir = join(AD_FIX, version === "v1" ? "real-v1" : "real-v2");
  for (const uuid of realV1Uuids()) {
    const endpoint = version === "v1" ? `/rest/api/automation/chain/${uuid}` : `/rest/api/automation/chain/v2/${uuid}?basicInfo=false`;
    const c = await expertlyGet(endpoint);
    writeFixture(dir, `${uuid}.${version}.json`, parseJson(c, uuid), { source: { uuid }, endpoint, status: c.status });
  }
}

async function adDefinitions(n: number) {
  const ids = new Map<string, string[]>();
  const uuids = realV1Uuids();
  let used = 0;
  for (const uuid of uuids) {
    if (used >= n) break;
    const raw = JSON.parse(readFileSync(join(AD_FIX, "real-v1", `${uuid}.v1.json`), "utf8"));
    const services: any[] = JSON.parse(raw.jsonDefinition).services ?? [];
    const found = services.map((s) => s.automationId).filter((x) => x !== undefined && x !== null && x !== "");
    if (found.length === 0) continue;
    used++;
    for (const id of found) ids.set(String(id), [...(ids.get(String(id)) ?? []), uuid]);
  }
  const dir = join(AD_FIX, "definitions");
  for (const [id, usedBy] of ids) {
    const endpoint = `/rest/api/automations/${id}?basicinfo=false`;
    const c = await expertlyGet(endpoint);
    if (c.status !== 200 || !c.text) {
      console.log(`  skip ${id}: HTTP ${c.status} (${c.text.length} bytes)`);
      continue;
    }
    writeFixture(dir, `${id}.json`, JSON.parse(c.text), { source: { automationId: id, usedBy: [...new Set(usedBy)] }, endpoint, status: c.status });
  }
}

async function adCategories() {
  const dir = join(AD_FIX, "categories");
  const targets: Array<[string, string]> = [
    ["chain-category.json", "/rest/api/automation/chain/category?fetchSystemServices=false"],
    ["chain-category-system.json", "/rest/api/automation/chain/category?fetchSystemServices=true"],
    ["automation-services.json", "/rest/api/automation/services?limit=2000&offset=0"],
  ];
  for (const [file, endpoint] of targets) {
    const c = await expertlyGet(endpoint);
    writeFixture(dir, file, parseJson(c, file), { source: {}, endpoint, status: c.status });
  }
}

async function adNotFound() {
  const dir = join(AD_FIX, "not-found");
  const missing = "00000000000000000000000000000000";
  for (const [file, endpoint] of [
    ["v1-chain-missing.json", `/rest/api/automation/chain/${missing}`],
    ["v2-chain-missing.json", `/rest/api/automation/chain/v2/${missing}?basicInfo=false`],
  ] as const) {
    const c = await expertlyGet(endpoint);
    writeFixture(dir, file, { status: c.status, contentType: c.contentType, body: c.text }, {
      source: { uuid: missing }, endpoint, status: c.status, note: "wrapper: {status, contentType, body(raw text)}",
    });
  }
}

// ── PD ──────────────────────────────────────────────────────────────────────

async function pdPages(ids: string[]) {
  for (const id of ids) {
    const endpoint = `/rest/api/pagedesigner/pages/${id}`;
    const c = await expertlyGet(endpoint);
    const body = parseJson(c, id) as Record<string, unknown>;
    const bytes = writeFixture(PD_FIX, `${id}.json`, body, {
      source: { id, name: body.name, status: body.status, referenceId: body.referenceId ?? null }, endpoint, status: c.status,
    });
    if (bytes > 1024 * 1024) console.log(`  NOTE ${id} is ${(bytes / 1048576).toFixed(2)} MB`);
  }
}

async function pdSearch(name: string) {
  for (const status of ["DRAFT", "PUBLISHED"]) {
    const c = await expertlyGet(`/rest/api/pagedesigner/pages?name=${encodeURIComponent(name)}&apiInfoLevel=MEDIUM&status=${status}`);
    const rows = parseJson(c, "search") as any[];
    for (const r of rows) console.log(`${status}\t${r.id}\t${r.referenceId ?? ""}\t${r.pageType ?? ""}\t${r.name}`);
  }
}

async function pdList(pageType: string, limit: number) {
  const c = await expertlyGet(`/rest/api/pagedesigner/pages?apiInfoLevel=MEDIUM&pageType=${pageType}&status=DRAFT&limit=${limit}&offset=0`);
  const rows = parseJson(c, "list") as any[];
  for (const r of rows) console.log(`${r.id}\t${r.referenceId ?? ""}\t${r.status}\t${r.name}`);
}

// ── Teamwork ────────────────────────────────────────────────────────────────

async function teamwork(taskId: number, pageSize = 5) {
  const { teamworkFetch } = await import("../../integrations/teamwork/lib/api");
  const get = async (path: string) => {
    assertReadOnly("GET");
    const res = await teamworkFetch(path, { method: "GET" });
    return { status: res.status, text: await res.text() };
  };
  const taskPath = `/projects/api/v3/tasks/${taskId}.json?include=users,tags,projects,tasklists,workflows,workflows.stages&getSubTasks=true&includeCommentStats=true`;
  const t = await get(taskPath);
  if (t.status !== 200) throw new Error(`task ${taskId}: HTTP ${t.status}`);
  writeFixture(TW_FIX, `task-${taskId}.json`, JSON.parse(t.text), { source: { taskId }, endpoint: taskPath, status: t.status });
  // Small pageSize on purpose so the fixture exercises pagination (meta.page.hasMore).
  for (let page = 1; page <= 5; page++) {
    const path = `/projects/api/v3/tasks/${taskId}/comments.json?include=users,teams,files&orderBy=date&orderMode=asc&pageSize=${pageSize}&page=${page}`;
    const c = await get(path);
    if (c.status !== 200) throw new Error(`comments p${page}: HTTP ${c.status}`);
    const json = JSON.parse(c.text);
    writeFixture(TW_FIX, `task-${taskId}-comments-p${page}.json`, json, { source: { taskId, page, pageSize }, endpoint: path, status: c.status });
    if (json.meta?.page?.hasMore !== true) break;
  }
}

// ── Jenkins ─────────────────────────────────────────────────────────────────

async function jenkins() {
  const { assertJenkinsAuth, buildHeaders } = await import("../../integrations/migrations/lib/jenkins");
  const auth = assertJenkinsAuth(Config.getJenkins());
  const host = auth.baseUrl;
  const jobBase = `${host}/${auth.job.split("/").filter(Boolean).map((s) => `job/${encodeURIComponent(s)}`).join("/")}`;
  const deHost = (s: string) => s.split(host).join("https://jenkins.example.com");
  const get = async (url: string) => {
    assertReadOnly("GET");
    const res = await fetch(url, { method: "GET", headers: buildHeaders(auth) });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  const paramsUrl = `${jobBase}/api/json?tree=property[parameterDefinitions[name,type,description,choices,defaultParameterValue[value]]]`;
  const p = await get(paramsUrl);
  if (p.status !== 200) throw new Error(`params: HTTP ${p.status}`);
  writeFixture(MG_FIX, "job-parameters.json", JSON.parse(deHost(p.text)), { source: { job: auth.job }, endpoint: deHost(paramsUrl), status: p.status });

  const list = await get(`${jobBase}/api/json?tree=builds[number,result,building]{0,20}`);
  const builds = (JSON.parse(list.text).builds ?? []) as Array<{ number: number; result: string | null; building: boolean }>;
  const pick = builds.find((b) => !b.building && b.result === "SUCCESS") ?? builds.find((b) => !b.building);
  if (!pick) { console.log("  no finished build; skipping build/console"); return; }
  const buildUrl = `${jobBase}/${pick.number}/api/json`;
  const b = await get(buildUrl);
  writeFixture(MG_FIX, `build-${pick.number}.json`, JSON.parse(deHost(b.text)), { source: { build: pick.number }, endpoint: deHost(buildUrl), status: b.status });
  const logUrl = `${jobBase}/${pick.number}/logText/progressiveText?start=0`;
  const l = await get(logUrl);
  writeFixture(MG_FIX, `build-${pick.number}-console-0.txt`, deHost(l.text), {
    source: { build: pick.number, start: 0, "X-Text-Size": l.headers.get("X-Text-Size"), "X-More-Data": l.headers.get("X-More-Data") },
    endpoint: deHost(logUrl), status: l.status,
  });
}

// ── offline re-sanitize ──────────────────────────────────────────────────────

function resanitize(dir: string) {
  const walkDir = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkDir(join(d, e.name)) : e.name.endsWith(".json") ? [join(d, e.name)] : []));
  for (const f of walkDir(resolve(dir))) {
    if (f.endsWith("manifest.json")) continue;
    const text = readFileSync(f, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    const stats = { redactedKeys: 0, scrubbedStrings: 0, reencodedJsonStrings: 0 };
    const clean = sanitize(parsed, stats);
    if (stats.redactedKeys + stats.scrubbedStrings + stats.reencodedJsonStrings === 0) continue;
    writeFileSync(f, JSON.stringify(clean, null, 2) + "\n");
    console.log(`  resanitized ${f.slice(ROOT.length + 1)} ${JSON.stringify(stats)}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const [target, arg] = process.argv.slice(2);
switch (target) {
  case "ad-v1": await adChains("v1"); break;
  case "ad-v2": await adChains("v2"); break;
  case "ad-defs": await adDefinitions(Number(arg ?? 10)); break;
  case "ad-categories": await adCategories(); break;
  case "ad-notfound": await adNotFound(); break;
  case "pd": await pdPages((arg ?? "").split(",").filter(Boolean)); break;
  case "pd-search": await pdSearch(arg ?? ""); break;
  case "pd-list": await pdList(arg ?? "PAGE", Number(process.argv[4] ?? 40)); break;
  case "tw": await teamwork(Number(arg), Number(process.argv[4] ?? 5)); break;
  case "jenkins": await jenkins(); break;
  case "resanitize": resanitize(arg ?? "."); break;
  default:
    console.error("usage: bun scripts/fixtures/capture.ts <ad-v1|ad-v2|ad-defs|ad-categories|ad-notfound|pd ids|pd-search name|tw taskId|jenkins>");
    process.exit(2);
}
process.exit(0);
