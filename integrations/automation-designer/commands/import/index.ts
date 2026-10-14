import { readFile } from "fs/promises";
import { CliError, type CommandModule, currentCacheEnv, defineArgs, isObj, ok, type Obj } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_YES_FLAG } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { dropMethodIndex } from "../../lib/method-finder";
import { CacheManager } from "../../lib/cache";
import { runValidationGate, type ValidationSummary } from "../../lib/save/validation";
import type { HydratedMethod } from "../../lib/types/common";
import type { V2MethodResponse } from "../../lib/types/v2-wire";
import { isHex32 } from "@belzabar/core/platform";

interface ImportArgs {
  filePath: string;
  yes: boolean;
  noValidate: boolean;
}

interface ImportMethodCheck {
  name: string;
  uuid: string | null;
  /** What the record's uuid is on the target env: new, an existing draft (overwritten), … */
  target: "new" | "existing-draft";
  format: "v1" | "v2";
}

interface ImportData {
  filePath: string;
  methods: ImportMethodCheck[];
  validation: ValidationSummary[];
  response: unknown;
}

export const args = defineArgs({
  command: "wi-impl ad import",
  positionals: [{ name: "file", required: true, missingCode: "MISSING_FILE", missingMessage: "Missing <file> argument." }],
  flags: {
    ...AD_YES_FLAG,
    "no-validate": { type: "boolean", description: "Skip the validator on V2 records. Logged loudly; not recommended" },
  },
});

const command: CommandModule<ImportArgs, ImportData> = {
  writes: true,
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { filePath: positionals.file, yes: flags.yes, noValidate: flags.noValidate };
  },
  async execute({ filePath, yes, noValidate }, context) {
    let text: string;
    try {
      text = await readFile(filePath, "utf-8");
    } catch (err) {
      throw new CliError(`Cannot read ${filePath}: ${String(err)}`, { code: "FILE_NOT_FOUND", details: { path: filePath } });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new CliError(`${filePath} is not valid JSON: ${(err as Error).message}`, { code: "INVALID_JSON" });
    }
    // A saved `--llm` envelope carries the export body in data.preview.
    const payload = unwrapEnvelope(parsed);

    // nothing unrecognised is ever sent.
    const records = extractMethodRecords(payload);
    if (records.length === 0) {
      throw new CliError(
        `No methods recognised in ${filePath} (expected the output of \`wi-impl ad export\` / \`export-category\`). Nothing was sent.`,
        { code: "AD_IMPORT_EMPTY", details: { path: filePath } },
      );
    }

    const methods: ImportMethodCheck[] = [];
    const validation: ValidationSummary[] = [];
    for (const { name, record } of records) {
      const check = checkRecordShape(name, record);
      // Draft guard: an import must never land on a PUBLISHED chain.
      const state = recordState(record);
      if (state === "PUBLISHED") {
        throw new CliError(
          `'${name}' is a PUBLISHED record; importing it could overwrite production. Export and import the DRAFT instead.`,
          { code: "AD_IMPORT_PUBLISHED", details: { name, uuid: check.uuid } },
        );
      }
      let existing: V2MethodResponse | undefined;
      if (check.uuid) {
        const found = await findOnTarget(check.uuid);
        if (found) {
          if (found.state !== "DRAFT") {
            throw new CliError(
              `'${name}' (${check.uuid}) exists on ${context.env.name} as ${found.state}; importing it could overwrite production. Nothing was sent.`,
              { code: "AD_IMPORT_TARGETS_PUBLISHED", details: { name, uuid: check.uuid, state: found.state } },
            );
          }
          check.target = "existing-draft";
          existing = check.format === "v2" ? (found.raw as V2MethodResponse) : undefined;
        }
      }
      if (check.format === "v2") {
        validation.push(
          await runValidationGate(
            { noValidate, strict: false, dryRunCompile: false },
            { after: record as V2MethodResponse, before: existing, env: context.env.name, action: `import of '${name}'`, warn: (m) => context.warn(m) },
          ),
        );
      }
      methods.push(check);
    }
    if (methods.some((m) => m.format === "v1")) {
      context.warn("V1 records (the `ad export` format) are checked for shape only; the validator runs on V2 bodies.");
    }

    await requireConfirmation({
      yes,
      outputMode: context.outputMode,
      action: `import ${methods.length} method(s)`,
      details: [
        ["File", filePath],
        ["Methods (first 10)", methods.slice(0, 10).map((m) => `${m.name}${m.target === "existing-draft" ? " (overwrites draft)" : ""}`).join(", ")],
        ["Total", String(methods.length)],
      ],
    });

    logIntent("POST", "/rest/api/automation/chain/import", { file: filePath, methodCount: methods.length });

    const response = await adApi.importMethods(payload);
    await dropMethodIndex(currentCacheEnv()); // imported uuids are unknown, so rebuild the index
    for (const m of methods) if (m.uuid) await CacheManager.invalidate(m.uuid);

    return ok<ImportData>({ filePath, methods, validation, response });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as ImportData;
    ui.success(`Imported methods from ${data.filePath}`);
    ui.section("Response");
    ui.object(data.response);
  },
};


/** The method's state as the record carries it (V1 automationState/state, V2 metadata.state). */
function recordState(r: Obj): string | null {
  const md = isObj(r.metadata) ? r.metadata : {};
  for (const v of [r.automationState, r.state, md.state]) if (typeof v === "string" && v.trim()) return v.trim().toUpperCase();
  return null;
}

/**
 * Refuse a record that has no definition the server can read (AD_IMPORT_INVALID):
 * V1 needs a jsonDefinition string that parses to an object with services[]
 * whose entries carry activeTab (the server NPEs otherwise); V2 needs steps[].
 */
function checkRecordShape(name: string, r: Obj): ImportMethodCheck {
  const uuid = typeof r.uuid === "string" && isHex32(r.uuid.trim()) ? r.uuid.trim().toLowerCase() : null;
  const bad = (why: string): never => {
    throw new CliError(`'${name}' cannot be imported: ${why}. Nothing was sent.`, { code: "AD_IMPORT_INVALID", details: { name, reason: why } });
  };
  if (Array.isArray(r.steps)) return { name, uuid, target: "new", format: "v2" };
  if (typeof r.jsonDefinition !== "string") return bad("the record has neither a V1 jsonDefinition string nor V2 steps[]");
  let jd: unknown;
  try {
    jd = JSON.parse(r.jsonDefinition);
  } catch {
    return bad("jsonDefinition is not valid JSON");
  }
  if (!isObj(jd) || !Array.isArray(jd.services)) return bad("jsonDefinition has no services[] array");
  jd.services.forEach((svc, i) => {
    if (!isObj(svc) || !isObj(svc.activeTab)) bad(`jsonDefinition.services[${i}] has no activeTab`);
  });
  return { name, uuid, target: "new", format: "v1" };
}

/** The method on the target env, or null when the uuid is unknown there. */
async function findOnTarget(uuid: string): Promise<HydratedMethod | null> {
  try {
    const m = await adApi.fetchMethod(uuid, "v2");
    return m;
  } catch (err) {
    if (err instanceof CliError && err.code === "METHOD_NOT_FOUND") return null;
    throw err;
  }
}

/** Every method record in an import file (same shapes as extractMethodNames). */
export function extractMethodRecords(payload: unknown): Array<{ name: string; record: Obj }> {
  const out: Array<{ name: string; record: Obj }> = [];
  const visit = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObj(node)) return;
    if (isObj(node.data) && "preview" in node.data) return visit(node.data.preview);
    if (isObj(node.chainDefinition)) return visit(node.chainDefinition);
    for (const key of ["chainDefinitions", "methods", "methodList"]) {
      if (Array.isArray(node[key])) return visit(node[key]);
    }
    const name = methodName(node);
    if (name) out.push({ name, record: node });
  };
  visit(payload);
  return out;
}

/**
 * One name per method in an import file. Understands wi-impl's own export
 * shapes: `ad export` → `{chainDefinition, testSuite}`,
 * `ad export-category` → `{chainDefinitions: [{chainDefinition, testSuite}]}`,
 * an `--llm` envelope around either (`data.preview`), plus plain method
 * records / lists (`methods`, `methodList`, arrays).
 */
export function extractMethodNames(payload: unknown): string[] {
  return extractMethodRecords(payload).map((r) => r.name);
}

function unwrapEnvelope(v: unknown): unknown {
  const d = (v as { data?: { preview?: unknown } } | null)?.data;
  return d && typeof d === "object" && "preview" in d ? d.preview : v;
}

function methodName(p: Record<string, unknown>): string | null {
  for (const v of [p.name, p.aliasName]) if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof p.jsonDefinition === "string") {
    try {
      const inner = JSON.parse(p.jsonDefinition) as { name?: unknown };
      if (typeof inner.name === "string" && inner.name.trim()) return inner.name.trim();
    } catch {
      /* not JSON — no name */
    }
  }
  return null;
}

export default command;
