import { describe, expect, test } from "bun:test";
import { parseMigrationOutput, stripAnsi } from "../../lib/log-parser";

describe("migrate log parser", () => {
  test("strips ansi sequences", () => {
    const value = "\u001b[94mHello\u001b[0m";
    expect(stripAnsi(value)).toBe("Hello");
  });

  test("extracts migration status and report summary", () => {
    const output = [
      "\u001b[94mde129afc-f45b-401a-b4f9-0c1cc0ff51b5 => PD :: Source: nsm-dev.nc.verifi.dev => Target: nsm-qa.nc.verifi.dev\u001b[0m",
      "\u001b[94mde129afc-f45b-401a-b4f9-0c1cc0ff51b5 => PD :: Status URL: https://example.com/status\u001b[0m",
      "\u001b[94mde129afc-f45b-401a-b4f9-0c1cc0ff51b5 => PD :: Details: https://example.com/details\u001b[0m",
      "\u001b[1m\u001b[32mde129afc-f45b-401a-b4f9-0c1cc0ff51b5 => PD :: Migration completed in 0:00:51 (migration_id: 621ae3de-2c9f-4995-b547-98c93a2e9196)\u001b[0m",
      "\u001b[94mde129afc-f45b-401a-b4f9-0c1cc0ff51b5 => REPORT :: Report result:\n",
      JSON.stringify({
        migrationId: "621ae3de-2c9f-4995-b547-98c93a2e9196",
        migrationStatus: "COMPLETED",
        statusCode: 200,
        comparisonResults: [
          { comparisonStatus: "MATCH", status: "SUCCESS" },
          { comparisonStatus: "MISMATCH", status: "SUCCESS" },
        ],
      }),
      "\n\u001b[1m\u001b[32mde129afc-f45b-401a-b4f9-0c1cc0ff51b5 => PD :: All migrations completed successfully\u001b[0m",
    ].join("\n");

    const parsed = parseMigrationOutput(output);
    expect(parsed.successDetected).toBe(true);
    expect(parsed.failureDetected).toBe(false);
    expect(parsed.runId).toBe("de129afc-f45b-401a-b4f9-0c1cc0ff51b5");
    expect(parsed.migrationId).toBe("621ae3de-2c9f-4995-b547-98c93a2e9196");
    expect(parsed.statusUrl).toBe("https://example.com/status");
    expect(parsed.detailsUrl).toBe("https://example.com/details");
    expect(parsed.reportSummary?.mismatchCount).toBe(1);
    expect(parsed.reportSummary?.successCount).toBe(2);
    expect(parsed.sourceHost).toBe("nsm-dev.nc.verifi.dev");
    expect(parsed.targetHost).toBe("nsm-qa.nc.verifi.dev");
  });
});
