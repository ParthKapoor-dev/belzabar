import { summarizeMigrationReport } from "./report";
import type { ParsedMigrationOutput } from "./types";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

function extractByRegex(text: string, regex: RegExp): string | undefined {
  const match = text.match(regex);
  return match?.[1];
}

function extractJsonBlockAfterMarker(text: string, marker: string): unknown {
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return undefined;

  const start = text.indexOf("{", markerIdx + marker.length);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const jsonText = text.slice(start, i + 1);
        try {
          return JSON.parse(jsonText);
        } catch {
          return undefined;
        }
      }
    }
  }

  return undefined;
}

export function parseMigrationOutput(rawOutput: string): ParsedMigrationOutput {
  const cleanedOutput = stripAnsi(rawOutput);

  const successDetected = /All migrations completed successfully/i.test(cleanedOutput);

  const failureHints = [
    ...Array.from(cleanedOutput.matchAll(/\b(failed|error|traceback|exception)\b/gi)).map((m) => m[0] as string),
  ];

  const failureDetected = /All migrations completed with errors/i.test(cleanedOutput) ||
    /\bTraceback\b/i.test(cleanedOutput) ||
    /\bMigration failed\b/i.test(cleanedOutput);

  const report = extractJsonBlockAfterMarker(cleanedOutput, "REPORT :: Report result:");

  return {
    cleanedOutput,
    successDetected,
    failureDetected,
    failureHints: Array.from(new Set(failureHints)).map((item) => item.toUpperCase()),
    runId: extractByRegex(cleanedOutput, /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*=>\s*(PD|AD)\s*::/i),
    migrationId: extractByRegex(cleanedOutput, /migration_id:\s*([0-9a-f-]{36})/i),
    statusUrl: extractByRegex(cleanedOutput, /Status URL:\s*(https?:\/\/\S+)/i),
    detailsUrl: extractByRegex(cleanedOutput, /Details:\s*(https?:\/\/\S+)/i),
    sourceHost: extractByRegex(cleanedOutput, /Source:\s*([^\s]+)\s*=>\s*Target:/i),
    targetHost: extractByRegex(cleanedOutput, /Source:\s*[^\s]+\s*=>\s*Target:\s*([^\s]+)/i),
    reportSummary: summarizeMigrationReport(report),
    rawReport: report,
  };
}
