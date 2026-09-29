import { readFile } from "fs/promises";
import { resolve } from "path";
import { CliError, defineSubcommands, failWithData, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { AD_COMMON_FLAGS, AD_YES_FLAG, resolveAdCommon } from "../../lib/args/common";
import { logIntent, requireConfirmation } from "../../lib/args/confirm";
import { resolveMethodRef } from "../../lib/ids";
import { loadTestSuite, type TestSuiteSummary } from "../../lib/test-suite";
import { caseFromWire, parseCaseInput, type CaseFile } from "../../lib/test-cases/case-file";
import { assertionFromExpectation, parseExpectation } from "../../lib/test-cases/expect";
import { methodDirFor, readCaseFiles, readMethodMeta, writeMethodDir, type MethodMeta, type WriteResult } from "../../lib/test-cases/files";
import {
  applySync,
  blockingProblems,
  checkCaseContract,
  checkPersisted,
  coerceInputValue,
  contractError,
  createCase,
  fetchSuite,
  planSync,
  updateCase,
  verifyError,
  type CaseCheck,
  type ContractProblem,
  type SyncItem,
  WRITE_ACTIONS,
} from "../../lib/test-cases/suite";
import { runSuiteCases, type SuiteRunSummary } from "../../lib/test-cases/run-suite";
import { splitInputPair } from "../../lib/input-collector";
import type { HydratedMethod } from "../../lib/types/common";

type Action = "list" | "create" | "update" | "delete" | "bulk" | "run-suite" | "delete-suite" | "export" | "sync";

interface CaseFlags {
  filePath?: string;
  name?: string;
  description?: string;
  /** Unset when not given (keeps parse results minimal). */
  inputs?: string[];
  asserts?: string[];
}

interface TestCaseArgs extends CaseFlags {
  action: Action;
  chainUuid?: string;
  testCaseId?: string;
  testSuiteId?: string;
  dir?: string;
  apply?: boolean;
  prune?: boolean;
  wait?: boolean;
  yes: boolean;
}

interface WriteData {
  action: "create" | "update" | "bulk";
  chainUuid: string;
  /** Every written case read back from the suite and compared with what was sent. */
  verified: boolean;
  checks: CaseCheck[];
  warnings: ContractProblem[];
  response?: unknown;
}

interface ExportData {
  action: "export";
  chainUuid: string;
  methodDir: string;
  method: MethodMeta;
  total: number;
  files: WriteResult;
}

interface SyncData {
  action: "sync";
  chainUuid: string;
  methodDir: string;
  applied: boolean;
  counts: Record<string, number>;
  plan: SyncItem[];
  problems: ContractProblem[];
  checks?: CaseCheck[];
  verified?: boolean;
}

/** `list` returns the same structured summary as `ad test-cases` (F24); other writes return the server response. */
type TestCaseData =
  | ({ action: "list" } & TestSuiteSummary)
  | WriteData
  | ExportData
  | SyncData
  | RunSuiteWaitData
  | { action: "delete" | "run-suite" | "delete-suite"; response: unknown; hint?: string };

/** `run-suite --wait`: every active case run now through /chain/test, assertions evaluated by belz. */
interface RunSuiteWaitData extends SuiteRunSummary {
  action: "run-suite";
  mode: "wait";
  chainUuid: string;
  testSuiteId: string | null;
}

const UUID = { name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing <uuid>." } as const;
const TC_ID = { name: "test-case-id", required: true, missingCode: "MISSING_TC_ID", missingMessage: "Missing <testCaseId>." } as const;
const CASE_FLAGS = {
  file: { type: "string" },
  input: { type: "string", repeatable: true },
  assert: { type: "string", repeatable: true },
} as const;

export const args = defineSubcommands(
  {
    list: { positionals: [UUID], flags: { ...AD_COMMON_FLAGS } },
    create: {
      positionals: [UUID],
      flags: { ...AD_COMMON_FLAGS, ...CASE_FLAGS, name: { type: "string" }, description: { type: "string", allowEmpty: true }, ...AD_YES_FLAG },
      requireOneOf: [["file", "name"]],
      codes: { MISSING_FLAG: "MISSING_FILE", MISSING_SUBCOMMAND: "MISSING_ACTION", UNKNOWN_SUBCOMMAND: "INVALID_ACTION" },
    },
    update: {
      positionals: [UUID, TC_ID],
      flags: { ...AD_COMMON_FLAGS, ...CASE_FLAGS, ...AD_YES_FLAG },
      requireOneOf: [["file", "input", "assert"]],
    },
    delete: { positionals: [TC_ID], flags: { ...AD_COMMON_FLAGS, ...AD_YES_FLAG } },
    bulk: {
      positionals: [UUID],
      flags: { ...AD_COMMON_FLAGS, file: { type: "string", required: true, missingCode: "MISSING_FILE", missingMessage: "Missing --file argument." }, ...AD_YES_FLAG },
    },
    "run-suite": { positionals: [UUID], flags: { ...AD_COMMON_FLAGS, wait: { type: "boolean" }, ...AD_YES_FLAG } },
    "delete-suite": {
      positionals: [{ name: "test-suite-id", required: true, missingCode: "MISSING_SUITE_ID", missingMessage: "Missing <testSuiteId>." }],
      flags: { ...AD_COMMON_FLAGS, ...AD_YES_FLAG },
    },
    export: {
      positionals: [UUID],
      flags: {
        ...AD_COMMON_FLAGS,
        dir: { type: "string", required: true, missingCode: "MISSING_DIR", missingMessage: "Missing --dir <root>." },
        prune: { type: "boolean" },
      },
    },
    sync: {
      positionals: [{ name: "dir", required: true, missingCode: "MISSING_DIR", missingMessage: "Missing <methodDir>." }],
      flags: { ...AD_COMMON_FLAGS, uuid: { type: "string" }, apply: { type: "boolean" }, prune: { type: "boolean" }, ...AD_YES_FLAG },
    },
  },
  {
    command: "belz ad test-case",
    codes: { MISSING_SUBCOMMAND: "MISSING_ACTION", UNKNOWN_SUBCOMMAND: "INVALID_ACTION" },
    missingMessage: "Usage: belz ad test-case <list|create|update|delete|bulk|run-suite|delete-suite|export|sync> ...",
  },
);

/** Repeatable flag values, or undefined when none were given. */
const some = (v: string[]): string[] | undefined => (v.length > 0 ? v : undefined);

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new CliError(`Cannot read ${path}: ${String(err)}`, { code: "FILE_NOT_FOUND" });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${String(err)}`, { code: "INVALID_JSON" });
  }
}

/** The case a create/update describes: --file, then --name/--description/--input/--assert on top. */
async function buildCase(f: CaseFlags, method: HydratedMethod, base?: CaseFile): Promise<CaseFile> {
  let c: CaseFile = base ? structuredClone(base) : { name: "", description: "", inputs: {}, assertions: [] };
  if (f.filePath) c = parseCaseInput(await readJson(f.filePath), f.filePath);
  if (f.name !== undefined) c.name = f.name;
  if (f.description !== undefined) c.description = f.description;
  const types = new Map(method.inputs.map((i) => [i.code, String(i.type ?? "")]));
  for (const s of f.inputs ?? []) {
    const [k, v] = splitInputPair(s);
    c.inputs[k] = coerceInputValue(v, types.get(k));
    if (c.inputExtras?.[k]) delete c.inputExtras[k];
  }
  // --assert replaces the file's / current assertions only when given.
  if (f.asserts && f.asserts.length > 0) {
    const fromFlags = f.asserts.map((s) => assertionFromExpectation(parseExpectation(s)));
    c.assertions = f.filePath ? [...c.assertions, ...fromFlags] : fromFlags;
  }
  if (!c.name.trim()) throw new CliError("A test case needs a name (--name or \"name\" in --file).", { code: "AD_TESTCASE_INVALID" });
  return c;
}

function contract(cases: CaseFile[], method: HydratedMethod): ContractProblem[] {
  const all = cases.flatMap((c) => checkCaseContract(c, method));
  const blocking = blockingProblems(all);
  if (blocking.length > 0) throw contractError(blocking, method.name);
  return all;
}

const RUN_SUITE_ASYNC_HINT =
  "The server runs the suite in the background and reports only by e-mail: `ad test-report` does not track it and the " +
  "suite's executionStatus ignores assertions. Use `ad test-case run-suite <uuid> --wait` for a per-case pass/fail result.";

async function fetchContract(uuid: string): Promise<HydratedMethod> {
  return adApi.fetchMethod(uuid, "v2");
}

const command: CommandModule<TestCaseArgs, TestCaseData> = {
  schema: "ad.test-case",
  writes: (a) => !["list", "export", "sync"].includes(a.action) || (a.action === "sync" && !!a.apply),
  requiresEnv: (a) => a.action === "sync", // the sync plan previews writes on the target env
  parseArgs(argv) {
    const p = args.parse(argv);
    resolveAdCommon(p.flags, "testCase", "test-case");
    const base = { yes: false };
    switch (p.subcommand) {
      case "list":
        return { ...base, action: "list", chainUuid: p.positionals.uuid };
      case "create":
        for (const s of p.flags.assert) assertionFromExpectation(parseExpectation(s));
        return {
          ...base,
          action: "create",
          chainUuid: p.positionals.uuid,
          filePath: p.flags.file,
          name: p.flags.name,
          description: p.flags.description,
          inputs: some(p.flags.input),
          asserts: some(p.flags.assert),
          yes: p.flags.yes,
        };
      case "update":
        for (const s of p.flags.assert) assertionFromExpectation(parseExpectation(s));
        return {
          ...base,
          action: "update",
          chainUuid: p.positionals.uuid,
          testCaseId: p.positionals.testCaseId,
          filePath: p.flags.file,
          inputs: some(p.flags.input),
          asserts: some(p.flags.assert),
          yes: p.flags.yes,
        };
      case "bulk":
        return { ...base, action: "bulk", chainUuid: p.positionals.uuid, filePath: p.flags.file, yes: p.flags.yes };
      case "run-suite":
        return { ...base, action: "run-suite", chainUuid: p.positionals.uuid, wait: p.flags.wait || undefined, yes: p.flags.yes };
      case "delete":
        return { ...base, action: "delete", testCaseId: p.positionals.testCaseId, yes: p.flags.yes };
      case "delete-suite":
        return { ...base, action: "delete-suite", testSuiteId: p.positionals.testSuiteId, yes: p.flags.yes };
      case "export":
        return { ...base, action: "export", chainUuid: p.positionals.uuid, dir: p.flags.dir, prune: p.flags.prune || undefined };
      case "sync":
        return {
          ...base,
          action: "sync",
          dir: p.positionals.dir,
          chainUuid: p.flags.uuid,
          apply: p.flags.apply || undefined,
          prune: p.flags.prune || undefined,
          yes: p.flags.yes,
        };
    }
  },
  async execute(rawArgs, context) {
    const args = rawArgs.chainUuid ? { ...rawArgs, chainUuid: resolveMethodRef(rawArgs.chainUuid) } : rawArgs;
    const confirm = (action: string, details: Array<[string, string]>) =>
      requireConfirmation({ yes: args.yes, outputMode: context.outputMode, action, details });

    switch (args.action) {
      case "list": {
        const uuid = args.chainUuid!;
        return ok<TestCaseData>({ action: "list", ...(await loadTestSuite(uuid)) });
      }

      case "create": {
        const uuid = args.chainUuid!;
        const method = await fetchContract(uuid);
        const c = await buildCase(args, method);
        const warnings = contract([c], method);
        const before = await fetchSuite(uuid);
        if (before.cases.some((s) => s.file.name === c.name)) {
          throw new CliError(`A test case named '${c.name}' already exists on ${method.name}; use \`test-case update\` or \`test-case sync\`.`, {
            code: "AD_TESTCASE_EXISTS",
            details: { name: c.name, ids: before.cases.filter((s) => s.file.name === c.name).map((s) => s.id) },
          });
        }
        await confirm(`create test case '${c.name}' on ${method.name}`, [
          ["Method UUID", uuid],
          ["Test case", c.name],
          ["Inputs", Object.keys(c.inputs).join(", ") || "(none)"],
          ["Assertions", String(c.assertions.length)],
        ]);
        logIntent("POST", `/rest/api/automation/chain/testcases/${uuid}`, { name: c.name });
        const id = await createCase(uuid, c);
        const check = checkPersisted(c, await fetchSuite(uuid), id);
        const data: WriteData = { action: "create", chainUuid: uuid, verified: check.verified, checks: [check], warnings };
        if (!check.verified) return failWithData("AD_TESTCASE_VERIFY_FAILED", verifyError([check]).message, data);
        return ok<TestCaseData>(data);
      }

      case "update": {
        const uuid = args.chainUuid!;
        const id = args.testCaseId!;
        const [method, suite] = await Promise.all([fetchContract(uuid), fetchSuite(uuid)]);
        const current = suite.cases.find((s) => s.id === id);
        if (!current) {
          throw new CliError(`Test case ${id} is not in ${method.name}'s suite.`, { code: "AD_TESTCASE_NOT_FOUND", details: { id, uuid } });
        }
        const c = await buildCase(args, method, current.file);
        // PUT replaces inputs + assertions only; the server keeps name/description (live sems-dev),
        // and a deleted case's name is never released, so they cannot be changed at all.
        const fixed = (["name", "description"] as const).filter((k) => c[k] !== current.file[k]);
        if (fixed.length > 0) {
          throw new CliError(
            `A test case's ${fixed.join(" and ")} cannot be changed through the API (PUT answers 200 and keeps the old value; ` +
              "DELETE is soft and never releases the name). Keep the current value, or create a case under a new name.",
            { code: "AD_TESTCASE_FIELD_NOT_UPDATABLE", details: { fields: fixed, id, current: { name: current.file.name, description: current.file.description } } },
          );
        }
        const warnings = contract([c], method);
        await confirm(`update test case ${id} ('${c.name}')`, [
          ["Method UUID", uuid],
          ["Test case ID", id],
          ["Inputs", Object.keys(c.inputs).join(", ") || "(none)"],
          ["Assertions", String(c.assertions.length)],
        ]);
        logIntent("PUT", `/rest/api/automation/chain/testcases/${uuid}/${id}`, { name: c.name });
        await updateCase(uuid, id, c);
        const check = checkPersisted(c, await fetchSuite(uuid), id);
        const data: WriteData = { action: "update", chainUuid: uuid, verified: check.verified, checks: [check], warnings };
        if (!check.verified) return failWithData("AD_TESTCASE_VERIFY_FAILED", verifyError([check]).message, data);
        return ok<TestCaseData>(data);
      }

      case "delete": {
        await confirm(`delete test case ${args.testCaseId}`, [["Test case ID", args.testCaseId!]]);
        logIntent("DELETE", `/rest/api/automation/chain/testcases/${args.testCaseId}`, {});
        await adApi.deleteTestCase(args.testCaseId!);
        return ok<TestCaseData>({ action: "delete", response: { deleted: args.testCaseId } });
      }

      case "bulk": {
        const uuid = args.chainUuid!;
        const body = await readJson(args.filePath!);
        if (!Array.isArray(body)) throw new CliError(`${args.filePath} must hold an array of test cases.`, { code: "AD_TESTCASE_INVALID" });
        const cases = body.map((b, i) => parseCaseInput(b, `${args.filePath}[${i}]`));
        const method = await fetchContract(uuid);
        const warnings = contract(cases, method);
        const before = await fetchSuite(uuid);
        const taken = cases.filter((c) => before.cases.some((s) => s.file.name === c.name)).map((c) => c.name);
        const dupes = cases.filter((c, i) => cases.findIndex((d) => d.name === c.name) !== i).map((c) => c.name);
        if (taken.length > 0 || dupes.length > 0) {
          throw new CliError(`Test case name(s) already used: ${[...new Set([...taken, ...dupes])].join(", ")}. Use \`test-case sync\` to update existing cases.`, {
            code: "AD_TESTCASE_EXISTS",
            details: { existing: taken, duplicatedInFile: dupes },
          });
        }
        await confirm(`bulk-create ${cases.length} test cases on ${method.name}`, [
          ["Method UUID", uuid],
          ["File", args.filePath!],
          ["Count", String(cases.length)],
        ]);
        // The /testcases/bulk route takes {fieldCode: string} inputs only (400 on the UI body):
        // create one by one, each fully encoded.
        logIntent("POST", `/rest/api/automation/chain/testcases/${uuid} (x${cases.length})`, { count: cases.length });
        const ids: Array<string | null> = [];
        for (const c of cases) ids.push(await createCase(uuid, c));
        const suite = await fetchSuite(uuid);
        const checks = cases.map((c, i) => checkPersisted(c, suite, ids[i]));
        const data: WriteData = { action: "bulk", chainUuid: uuid, verified: checks.every((c) => c.verified), checks, warnings };
        if (!data.verified) return failWithData("AD_TESTCASE_VERIFY_FAILED", verifyError(checks).message, data);
        return ok<TestCaseData>(data);
      }

      case "run-suite": {
        if (args.wait) {
          const uuid = args.chainUuid!;
          const [method, suite] = await Promise.all([adApi.fetchMethod(uuid, "v1"), fetchSuite(uuid)]);
          if (suite.cases.length === 0) {
            await loadTestSuite(uuid); // METHOD_NOT_FOUND for an unknown / deleted uuid
            throw new CliError(`${method.name} has no active test cases to run.`, { code: "AD_TESTCASE_NONE", details: { uuid, testSuiteId: suite.testSuiteId } });
          }
          await confirm(`run ${suite.cases.length} test case(s) of ${method.name} now, one execution each (real side effects)`, [
            ["Method UUID", uuid],
            ["Test cases", suite.cases.map((c) => c.file.name).join(", ")],
          ]);
          logIntent("POST", `/rest/api/automation/chain/test (x${suite.cases.length})`, { chainUuid: uuid, wait: true });
          const summary = await runSuiteCases(method, suite);
          const data: RunSuiteWaitData = { action: "run-suite", mode: "wait", chainUuid: uuid, testSuiteId: suite.testSuiteId, ...summary };
          if (summary.failed + summary.errored > 0) {
            const bad = summary.cases.filter((c) => c.status !== "PASS");
            return failWithData(
              "AD_TESTCASE_SUITE_FAILED",
              `${bad.length} of ${summary.total} test case(s) did not pass: ${bad.map((c) => `${c.name} ${c.status}`).join(", ")}`,
              data,
            );
          }
          return ok<TestCaseData>(data);
        }
        await confirm(`run test suite for ${args.chainUuid}`, [["Method UUID", args.chainUuid!]]);
        logIntent("POST", "/rest/api/automation/chain/testsuite/execute", { chainUuid: args.chainUuid });
        const response = await adApi.runTestSuite(args.chainUuid!);
        return ok<TestCaseData>({ action: "run-suite", response, hint: RUN_SUITE_ASYNC_HINT });
      }

      case "delete-suite": {
        await confirm(`delete test suite ${args.testSuiteId}`, [["Suite ID", args.testSuiteId!]]);
        logIntent("DELETE", `/rest/api/automation/chain/testsuite/${args.testSuiteId}`, {});
        await adApi.deleteTestSuite(args.testSuiteId!);
        return ok<TestCaseData>({ action: "delete-suite", response: { deleted: args.testSuiteId } });
      }

      case "export": {
        const uuid = args.chainUuid!;
        const [method, suite] = await Promise.all([fetchContract(uuid), fetchSuite(uuid)]);
        const root = resolve(args.dir!);
        const category = method.category?.name ?? null;
        const methodDir = methodDirFor(root, category, method.name);
        const prior = readMethodMeta(methodDir);
        const meta: MethodMeta = {
          name: method.name,
          category,
          uuids: { ...(prior?.uuids ?? {}), [context.env.name]: uuid },
          inputs: Object.fromEntries(method.inputs.filter((i) => !i.hideInput).map((i) => [i.code, String(i.type ?? "")])),
          outputs: method.outputs.map((o) => o.code),
        };
        const files = writeMethodDir(methodDir, meta, suite.cases.map((c) => c.file), !!args.prune);
        return ok<TestCaseData>({ action: "export", chainUuid: uuid, methodDir, method: meta, total: suite.cases.length, files });
      }

      case "sync": {
        const methodDir = resolve(args.dir!);
        const meta = readMethodMeta(methodDir);
        const uuid = args.chainUuid ?? (meta?.uuids[context.env.name] ? resolveMethodRef(meta.uuids[context.env.name]!) : undefined);
        if (!uuid) {
          throw new CliError(
            `${methodDir}/method.json has no uuid for ${context.env.name}; pass --uuid <chainUuid> (known envs: ${Object.keys(meta?.uuids ?? {}).join(", ") || "none"}).`,
            { code: "AD_TESTCASE_NO_UUID" },
          );
        }
        const files = readCaseFiles(methodDir).map((l) => l.file);
        const [method, suite] = await Promise.all([fetchContract(uuid), fetchSuite(uuid)]);
        if (meta?.name && meta.name !== method.name) {
          context.warn(`method.json names '${meta.name}' but ${uuid} is '${method.name}' on ${context.env.name}.`);
        }
        const problems = files.flatMap((c) => checkCaseContract(c, method));
        const plan = planSync(files, suite, !!args.prune);
        const counts: Record<string, number> = {};
        for (const it of plan) counts[it.action] = (counts[it.action] ?? 0) + 1;
        const data: SyncData = { action: "sync", chainUuid: uuid, methodDir, applied: false, counts, plan, problems };
        const writes = plan.filter((p) => WRITE_ACTIONS.includes(p.action));
        if (!args.apply || writes.length === 0) return ok<TestCaseData>(data);

        const blocking = blockingProblems(problems);
        if (blocking.length > 0) return failWithData("AD_TESTCASE_CONTRACT", contractError(blocking, method.name).message, data);
        await confirm(`sync ${writes.length} test case change(s) to ${method.name}`, [
          ["Method UUID", uuid],
          ["Directory", methodDir],
          ...WRITE_ACTIONS.filter((k) => counts[k]).map((k): [string, string] => [k, String(counts[k])]),
        ]);
        logIntent("POST", `/rest/api/automation/chain/testcases/${uuid} (sync)`, counts);
        const written = await applySync(uuid, plan, files);
        const after = await fetchSuite(uuid);
        const planned = new Map(plan.map((p) => [p.name, p]));
        // Existing cases keep their description on the server (drift is reported, not written).
        const checks = files.map((f) => {
          const created = planned.get(f.name)?.action === "create";
          return checkPersisted(f, after, written.get(f.name) ?? planned.get(f.name)?.id, created ? [] : ["description"]);
        });
        data.applied = true;
        data.checks = checks;
        const failedItems = plan.filter((p) => p.error);
        const notDeleted = plan.filter((p) => p.action === "delete" && after.cases.some((c) => c.id === p.id)).map((p) => p.name);
        data.verified = checks.every((c) => c.verified) && notDeleted.length === 0 && failedItems.length === 0;
        if (failedItems.length > 0) {
          return failWithData(
            "AD_TESTCASE_SYNC_FAILED",
            `${failedItems.length} sync write(s) failed: ${failedItems.map((p) => `${p.action} ${p.name}: ${p.error!.message}`).join("; ")}`,
            data,
          );
        }
        if (!data.verified) return failWithData("AD_TESTCASE_VERIFY_FAILED", verifyError(checks, { notDeleted }).message, data);
        return ok<TestCaseData>(data);
      }
    }
  },
  presentHuman(envelope, ui) {
    const data = envelope.data as TestCaseData | null;
    if (!data) return;
    if (data.action === "list") {
      ui.table(
        ["Property", "Value"],
        [
          ["Method UUID", data.uuid],
          ["Suite ID", data.testSuiteId ?? "(none)"],
          ["Test Cases", data.total],
        ],
      );
      if (data.testCases.length > 0) {
        ui.table(
          ["ID", "Name", "Active", "Inputs", "Assertions"],
          data.testCases.map((c) => [c.id, c.name, c.active ? "Yes" : "No", c.inputCount, c.assertionCount]),
        );
      }
      return;
    }
    if (data.action === "create" || data.action === "update" || data.action === "bulk") {
      for (const c of data.checks) {
        if (c.verified) ui.success(`${data.action}: ${c.name} (${c.id}) — verified on read-back`);
        else ui.error(`${data.action}: ${c.name} — read-back differs: ${c.mismatched.join(", ")}`);
      }
      for (const w of data.warnings) ui.warn(`${w.case}: ${w.kind} '${w.key}'`);
      return;
    }
    if (data.action === "export") {
      ui.success(`Exported ${data.total} test case(s) to ${data.methodDir}`);
      ui.text(`${data.files.written.length} written, ${data.files.unchanged.length} unchanged`);
      for (const s of data.files.stale) ui.warn(`${data.files.removed.includes(s) ? "removed" : "stale (not on the server; --prune removes)"}: ${s}`);
      return;
    }
    if (data.action === "sync") {
      ui.section(`Sync ${data.methodDir} → ${data.chainUuid}${data.applied ? "" : " (dry run)"}`);
      for (const p of data.plan) {
        const extra = p.changes ? ` [${p.changes.join(", ")}]` : p.note ? ` — ${p.note}` : "";
        ui.text(`${p.action.padEnd(9)} ${p.name}${extra}`);
      }
      for (const w of data.problems) ui.warn(`${w.case}: ${w.kind} '${w.key}'`);
      ui.text(Object.entries(data.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no test cases");
      for (const p of data.plan) if (p.error) ui.error(`${p.action} ${p.name}: ${p.error.message}`);
      if (!data.applied && data.plan.some((p) => WRITE_ACTIONS.includes(p.action))) ui.info("Dry run: re-run with --apply to write.");
      if (data.applied) {
        if (data.verified) ui.success("All synced test cases verified on read-back.");
        else ui.error("Read-back verification failed (see checks).");
      }
      return;
    }
    if (data.action === "run-suite" && "mode" in data) {
      ui.section(`Test suite ${data.chainUuid} (run now by belz)`);
      for (const c of data.cases) {
        const why =
          c.status === "ERROR"
            ? ` — ${c.error ?? c.failedStep?.parsedError.summary ?? "execution failed"}`
            : c.status === "FAIL"
              ? ` — ${c.assertions.results.filter((r) => !r.pass).map((r) => `${r.expectation} (${r.reason})`).join("; ")}`
              : "";
        const line = `${c.status.padEnd(5)} ${c.name} (${c.assertions.passed}/${c.assertions.total} assertions)${why}`;
        if (c.status === "PASS") ui.success(line);
        else ui.error(line);
        for (const u of c.unevaluated) ui.info(`      SKIP ${u} (not evaluated locally)`);
      }
      ui.text(`${data.passed} passed, ${data.failed} failed, ${data.errored} errored of ${data.total}`);
      return;
    }
    ui.success(`test-case ${data.action} complete`);
    if (data.action === "run-suite") {
      ui.warn(RUN_SUITE_ASYNC_HINT);
    }
    ui.section("Response");
    ui.object(data.response);
  },
};

export default command;
