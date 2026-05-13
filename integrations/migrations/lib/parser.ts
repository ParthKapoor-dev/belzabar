import { summarizeReport } from "./report";
import type { ParsedMigrationOutput, RawReport } from "./types";

const ANSI_PATTERN = /\[[0-9;]*m/g;
// Jenkins Pipeline step markers: `ha:////<base64>==` inserted inline by the
// workflow plugin. Strip them so downstream parsing + artifacts are readable.
const PIPELINE_STEP_MARKER = /ha:\/\/\/\/\S+?={1,2}/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(PIPELINE_STEP_MARKER, "");
}

function extract(text: string, regex: RegExp): string | undefined {
  return text.match(regex)?.[1];
}

function extractJsonAfter(text: string, marker: string): unknown {
  const idx = text.indexOf(marker);
  if (idx === -1) return undefined;
  const start = text.indexOf("{", idx + marker.length);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); }
        catch { return undefined; }
      }
    }
  }
  return undefined;
}

export function parseJenkinsConsole(raw: string): ParsedMigrationOutput {
  const cleanedOutput = stripAnsi(raw);

  const finishedResult = extract(cleanedOutput, /^Finished:\s*(SUCCESS|FAILURE|UNSTABLE|ABORTED)\s*$/m);

  const successDetected =
    /All migrations completed successfully/i.test(cleanedOutput) ||
    finishedResult === "SUCCESS";

  const failureDetected =
    /All migrations completed with errors/i.test(cleanedOutput) ||
    /\bTraceback\b/.test(cleanedOutput) ||
    /\bMigration failed\b/i.test(cleanedOutput) ||
    finishedResult === "FAILURE" ||
    finishedResult === "ABORTED";

  const failureHints = Array.from(
    new Set(
      Array.from(cleanedOutput.matchAll(/\b(failed|error|traceback|exception)\b/gi)).map(
        (m) => (m[0] as string).toUpperCase()
      )
    )
  );

  const reportRaw =
    (extractJsonAfter(cleanedOutput, "REPORT :: Report response received:") as RawReport | undefined) ??
    (extractJsonAfter(cleanedOutput, "REPORT :: Report result:") as RawReport | undefined);

  return {
    cleanedOutput,
    successDetected,
    failureDetected,
    finishedResult,
    runId: extract(cleanedOutput, /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*=>\s*(?:PD|AD|AD_Method|AD_Service)\s*::/i),
    migrationId: extract(cleanedOutput, /migration_id:\s*([0-9a-f-]{36})/i),
    sourceProfile: extract(cleanedOutput, /Profile:\s*(\S+)\s*\|\s*Source:/i),
    sourceDb: extract(cleanedOutput, /Profile:\s*\S+\s*\|\s*Source:\s*(\S+)\s*\|\s*Target:/i),
    targetDb: extract(cleanedOutput, /Profile:\s*\S+\s*\|\s*Source:\s*\S+\s*\|\s*Target:\s*(\S+)/i),
    sourceHost: extract(cleanedOutput, /AD\s*::\s*Source:\s*(\S+)\s*=>\s*Target:/i),
    targetHost: extract(cleanedOutput, /AD\s*::\s*Source:\s*\S+\s*=>\s*Target:\s*(\S+)/i),
    failureHints,
    reportSummary: summarizeReport(reportRaw),
    rawReport: reportRaw,
  };
}
