import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { CliError, defineArgs, fail, ok, readJsonOrNull, type CommandModule } from "@belzabar/core";
import { fetchRawMethod, testMethodMultipart } from "../../lib/api/v1";
import { buildV1TestPayload, describeTestFailure, v1TestFormData } from "../../lib/payload-builder";
import { resolveMethodRef } from "@belzabar/core/platform";

interface SuiteResult {
  name: string;
  uuid: string;
  status: "passed" | "failed";
  reason?: string;
}

interface RunSuitesData {
  total: number;
  passed: number;
  failed: number;
  suites: SuiteResult[];
}

interface TestExecutionResponse {
  executionStatus?: {
    failed?: boolean;
    error?: unknown;
  };
}

export const args = defineArgs({
  command: "wi-impl ad run-suites",
  flags: {
    "legacy-env": {
      type: "string",
      description: "Env that suites without an `env` field were saved for; they run only when it equals --env",
    },
  },
});

interface RunSuitesArgs {
  legacyEnv?: string;
}

const command: CommandModule<RunSuitesArgs, RunSuitesData> = {
  // Executes every suite's chain (SQL/HTTP steps really run): explicit --env required.
  writes: true,
  parseArgs(argv) {
    const { flags } = args.parse(argv);
    return { legacyEnv: flags.legacyEnv?.trim() || undefined };
  },
  async execute({ legacyEnv }, context) {
    const suitesDir = join(process.cwd(), "suites");
    if (!existsSync(suitesDir)) {
      throw new CliError("No suites directory found.", { code: "SUITES_DIR_MISSING" });
    }

    const files = readdirSync(suitesDir).filter(f => f.endsWith(".spec.json"));
    if (files.length === 0) {
      return ok({ total: 0, passed: 0, failed: 0, suites: [] });
    }

    const suites: SuiteResult[] = [];
    let passed = 0;
    let failed = 0;

    let legacy = 0;
    for (const file of files) {
      const suitePath = join(suitesDir, file);
      // a malformed suite fails on its own; the earlier suites already ran
      // (with side effects), so the run must still end with a summary.
      let suite: { name: string; uuid: string; env?: string; inputs?: Record<string, unknown> };
      try {
        const parsed = (await Bun.file(suitePath).json()) as unknown;
        if (!parsed || typeof parsed !== "object" || typeof (parsed as { uuid?: unknown }).uuid !== "string") {
          throw new Error("not a suite object with a uuid");
        }
        suite = parsed as typeof suite;
      } catch (error) {
        suites.push({ name: file, uuid: "", status: "failed", reason: `INVALID_JSON: ${(error as Error).message}` });
        failed++;
        continue;
      }
      // Suites name a bare uuid: a suite saved on one env must not replay on another.
      if (typeof suite.env === "string" && suite.env !== context.env.name) {
        suites.push({
          name: suite.name ?? file,
          uuid: suite.uuid,
          status: "failed",
          reason: `ENV_MISMATCH: saved for ${suite.env}, not run on ${context.env.name}`,
        });
        failed++;
        continue;
      }
      // a suite saved before save-suite recorded the env names a bare
      // uuid of an unknown env. It is refused unless the operator states which
      // env such suites belong to (--legacy-env) and that is the target env.
      if (typeof suite.env !== "string") {
        legacy++;
        if (legacyEnv !== context.env.name) {
          suites.push({
            name: suite.name ?? file,
            uuid: suite.uuid,
            status: "failed",
            reason: legacyEnv
              ? `ENV_MISSING: no env recorded; --legacy-env ${legacyEnv} is not ${context.env.name}`
              : `ENV_MISSING: no env recorded; pass --legacy-env ${context.env.name} if it was saved for ${context.env.name}, or re-save it`,
          });
          failed++;
          continue;
        }
      }

      try {
        // the same `/chain/test` body `ad test` posts (not the whole GET body).
        const rawMethod = await fetchRawMethod(resolveMethodRef(suite.uuid));
        const payload = await buildV1TestPayload(rawMethod, suite.inputs || {});
        const resultRes = await testMethodMultipart(v1TestFormData(payload));
        if (!resultRes.ok) {
          const failure = await describeTestFailure(resultRes);
          suites.push({
            name: suite.name,
            uuid: suite.uuid,
            status: "failed",
            reason: `API Request Failed: ${failure.message}`,
          });
          failed++;
          continue;
        }

        const result = ((await readJsonOrNull<TestExecutionResponse>(resultRes, { path: "/rest/api/automation/chain/test" })) ?? {}) as TestExecutionResponse;
        if (result.executionStatus?.failed) {
          suites.push({
            name: suite.name,
            uuid: suite.uuid,
            status: "failed",
            reason: JSON.stringify(result.executionStatus.error ?? "Unknown"),
          });
          failed++;
        } else {
          suites.push({
            name: suite.name,
            uuid: suite.uuid,
            status: "passed",
          });
          passed++;
        }
      } catch (error: any) {
        suites.push({
          name: suite.name,
          uuid: suite.uuid,
          status: "failed",
          reason: error.message || String(error),
        });
        failed++;
      }
    }

    if (legacy > 0) {
      context.warn(
        `${legacy} suite(s) carry no env (saved before suites recorded one)${legacyEnv === context.env.name ? ` and ran as ${legacyEnv} suites (--legacy-env)` : " and were not run"}; re-save them with \`wi-impl ad save-suite\` to pin the env.`,
      );
    }
    const summary: RunSuitesData = { total: files.length, passed, failed, suites };

    if (failed > 0) {
      return fail("SUITES_FAILED", "One or more suites failed.", { data: summary });
    }
    return ok(summary);
  },
  presentHuman(envelope, ui) {
    const data = envelope.data as RunSuitesData | null;
    if (!data) return;
    if (data.total === 0) {
      ui.info("No test suites found.");
      return;
    }
    ui.table(
      ["Suite", "UUID", "Status", "Reason"],
      data.suites.map(suite => [suite.name, suite.uuid, suite.status, suite.reason ?? ""])
    );
    ui.text(`\nSummary: ${data.passed} Passed, ${data.failed} Failed`);
    if (data.failed === 0) {
      ui.success("All suites passed.");
    } else {
      ui.warn("Some suites failed.");
    }
  },
};

export default command;
