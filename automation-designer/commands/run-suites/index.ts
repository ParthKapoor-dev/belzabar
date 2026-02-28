import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { CliError, fail, ok, type CommandModule } from "@belzabar/core";
import { fetchMethodDefinition, testMethod } from "../../lib/api";
import { PayloadBuilder } from "../../lib/payload-builder";
import type { RawMethodResponse } from "../../lib/types";

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

const command: CommandModule<undefined, RunSuitesData> = {
  schema: "ad.run-suites",
  parseArgs: () => undefined,
  async execute() {
    const suitesDir = join(process.cwd(), "suites");
    if (!existsSync(suitesDir)) {
      throw new CliError("No suites directory found.", { code: "SUITES_DIR_MISSING" });
    }

    const files = readdirSync(suitesDir).filter(f => f.endsWith(".spec.json"));
    if (files.length === 0) {
      return ok({
        total: 0,
        passed: 0,
        failed: 0,
        suites: [],
      });
    }

    const suites: SuiteResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const file of files) {
      const suitePath = join(suitesDir, file);
      const suite = await Bun.file(suitePath).json();

      try {
        const rawMethod = (await fetchMethodDefinition(suite.uuid)) as RawMethodResponse;
        const payload = PayloadBuilder.injectInputs(rawMethod, suite.inputs || {});
        const formData = new FormData();
        formData.append("body", JSON.stringify(payload));

        const resultRes = await testMethod(formData);
        if (!resultRes.ok) {
          suites.push({
            name: suite.name,
            uuid: suite.uuid,
            status: "failed",
            reason: `API Request Failed: ${resultRes.status}`,
          });
          failed++;
          continue;
        }

        const result = await resultRes.json();
        if (result.executionStatus?.failed) {
          suites.push({
            name: suite.name,
            uuid: suite.uuid,
            status: "failed",
            reason: JSON.stringify(result.executionStatus.error || "Unknown"),
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

    const summary = {
      total: files.length,
      passed,
      failed,
      suites,
    };

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
