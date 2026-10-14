// Live-suite cleanup helper: soft-delete belz_tst_ methods in the live
// category on the live env, including PUBLISHED copies (which `belz ad delete` refuses by
// design). Spawned by the write suite's afterAll with WI_IMPL_HOME = the seeded
// live home; never imported by the CLI.
//
//   bun soft-delete.ts <uuid>...   → one JSON line: [{uuid, result, name?}]
//
// Guards (fail closed): env WI_IMPL_LIVE only, the V2 body must name a
// `belz_tst_` method in chain category WI_IMPL_LIVE_CATEGORY_ID. A uuid whose V2
// read is already METHOD_NOT_FOUND counts as gone.
import { CliError, Config } from "@belzabar/core";
import * as v2 from "@belzabar/ad/lib/api/v2";
import { deleteChainV2 } from "@belzabar/ad/lib/save/api";

// Same variables as core/testing live.ts (not imported: it pulls in bun:test).
const LIVE_ENV = process.env.WI_IMPL_LIVE?.trim() ?? "";
const LIVE_CHAIN_CATEGORY = Number(process.env.WI_IMPL_LIVE_CATEGORY_ID);
if (!LIVE_ENV || !Number.isSafeInteger(LIVE_CHAIN_CATEGORY) || LIVE_CHAIN_CATEGORY <= 0) {
  throw new Error("soft-delete: WI_IMPL_LIVE and WI_IMPL_LIVE_CATEGORY_ID must be set");
}

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
  if (!name.startsWith("belz_tst_") || Number(service?.id) !== LIVE_CHAIN_CATEGORY) {
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
