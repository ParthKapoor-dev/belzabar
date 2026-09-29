// Live-suite cleanup helper: soft-delete belz_tst_ methods in Test-Parth on
// sems-dev, including PUBLISHED copies (which `belz ad delete` refuses by
// design). Spawned by the write suite's afterAll with BELZ_HOME = the seeded
// live home; never imported by the CLI.
//
//   bun soft-delete.ts <uuid>...   → one JSON line: [{uuid, result, name?}]
//
// Guards (fail closed): env sems-dev only, the V2 body must name a
// `belz_tst_` method in chain category 1135 (Test-Parth). A uuid whose V2
// read is already METHOD_NOT_FOUND counts as gone.
import { CliError, Config } from "@belzabar/core";
import * as v2 from "@belzabar/ad/lib/api/v2";
import { deleteChainV2 } from "@belzabar/ad/lib/save/api";

const LIVE_ENV = "sems-dev";
const TEST_PARTH_CHAIN_CATEGORY = 1135;

type Result = { uuid: string; result: "deleted" | "gone" | "refused" | "error"; name?: string; detail?: string };

async function softDelete(uuid: string): Promise<Result> {
  let body: Awaited<ReturnType<typeof v2.fetchRawMethod>>;
  try {
    body = await v2.fetchRawMethod(uuid);
  } catch (err) {
    if (err instanceof CliError && err.code === "METHOD_NOT_FOUND") return { uuid, result: "gone" };
    return { uuid, result: "error", detail: String(err) };
  }
  const name = String((body as { name?: unknown }).name ?? "");
  const service = (body as { metadata?: { service?: { id?: unknown } } }).metadata?.service;
  if (!name.startsWith("belz_tst_") || Number(service?.id) !== TEST_PARTH_CHAIN_CATEGORY) {
    return { uuid, result: "refused", name, detail: `category ${String(service?.id)}` };
  }
  try {
    await deleteChainV2(uuid);
  } catch (err) {
    return { uuid, result: "error", name, detail: String(err) };
  }
  try {
    await v2.fetchRawMethod(uuid);
    return { uuid, result: "error", name, detail: "still reads back on V2 after DELETE" };
  } catch (err) {
    if (err instanceof CliError && err.code === "METHOD_NOT_FOUND") return { uuid, result: "deleted", name };
    return { uuid, result: "error", name, detail: String(err) };
  }
}

Config.setActiveEnv(LIVE_ENV);
const results: Result[] = [];
for (const uuid of process.argv.slice(2)) results.push(await softDelete(uuid.trim().toLowerCase()));
process.stdout.write(`${JSON.stringify(results)}\n`);
