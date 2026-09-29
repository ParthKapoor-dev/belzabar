// `codeFile` / `sqlFile` references in a compact spec or save overlay are read
// here (relative to the spec/overlay file) and replaced by `code` / `sql`, so
// agents never have to JSON-escape a script. Also turns `ad save`'s
// `--sql-file N=path` / `--code-file N=path` flags into update-step ops.

import { readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { CliError, isObj } from "@belzabar/core";

type Obj = Record<string, unknown>;

async function readText(path: string, baseDir: string, what: string): Promise<string> {
  const full = isAbsolute(path) ? path : resolve(baseDir, path);
  try {
    return await readFile(full, "utf-8");
  } catch (err) {
    throw new CliError(`Cannot read ${what} ${full}: ${String(err)}`, { code: "FILE_NOT_FOUND", details: { path: full } });
  }
}

/** Replace codeFile/sqlFile in one compact step (or update-step `set`) in place. */
async function resolveStep(s: unknown, baseDir: string, where: string): Promise<void> {
  if (!isObj(s)) return;
  for (const [fileKey, key] of [["codeFile", "code"], ["sqlFile", "sql"]] as const) {
    if (!(fileKey in s)) continue;
    if (key in s) throw new CliError(`${where}: give ${key} or ${fileKey}, not both.`, { code: "AD_OVERLAY_INVALID", details: { path: where } });
    if (typeof s[fileKey] !== "string") throw new CliError(`${where}.${fileKey} must be a file path.`, { code: "AD_OVERLAY_INVALID", details: { path: where } });
    s[key] = await readText(s[fileKey] as string, baseDir, `${where}.${fileKey}`);
    delete s[fileKey];
  }
}

/** Compact spec (`ad create --spec`): every steps[] entry. */
export async function resolveSpecSources(spec: unknown, baseDir: string): Promise<void> {
  if (!isObj(spec) || !Array.isArray(spec.steps)) return;
  for (const [i, s] of spec.steps.entries()) await resolveStep(s, baseDir, `steps[${i}]`);
}

/** Save overlay: add-step `step` and update-step `set`. */
export async function resolveOverlaySources(overlay: unknown, baseDir: string): Promise<void> {
  if (!isObj(overlay) || !Array.isArray(overlay.ops)) return;
  for (const [i, op] of overlay.ops.entries()) {
    if (!isObj(op)) continue;
    if (op.op === "add-step") await resolveStep(op.step, baseDir, `ops[${i}].step`);
    if (op.op === "update-step") await resolveStep(op.set, baseDir, `ops[${i}].set`);
  }
}

/** `N=path` → [N, path]; the step number is the fetched position (as `ad show` prints it). */
function parseStepFile(v: string, flag: string): { step: number; path: string } {
  const m = /^(\d+)=(.+)$/.exec(v);
  if (!m || Number(m[1]) < 1) {
    throw new CliError(`${flag} expects <step>=<file> (e.g. ${flag} 3=query.sql), got '${v}'.`, { code: "INVALID_VALUE", details: { flag, value: v } });
  }
  return { step: Number(m[1]), path: m[2]! };
}

/**
 * Append `--sql-file` / `--code-file` as update-step ops to the overlay
 * (creating `{ops: []}` when there is no overlay file).
 */
export async function addFileFlagOps(overlay: Obj, flags: { sqlFiles: string[]; codeFiles: string[] }, cwd: string): Promise<void> {
  const ops = Array.isArray(overlay.ops) ? (overlay.ops as unknown[]) : [];
  for (const [flag, list, key] of [["--sql-file", flags.sqlFiles, "sql"], ["--code-file", flags.codeFiles, "code"]] as const) {
    for (const v of list) {
      const { step, path } = parseStepFile(v, flag);
      ops.push({ op: "update-step", step, set: { [key]: await readText(path, cwd, flag) } });
    }
  }
  if (ops.length) overlay.ops = ops;
}
