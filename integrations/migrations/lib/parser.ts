import { summarizeReport } from "./report";
import type { ParsedMigrationOutput, RawReport, SkippedEntity } from "./types";

// Jenkins Pipeline step markers: the workflow plugin emits `ha:////<base64>`
// blobs wrapped in a "conceal" SGR span (ESC[8m … ESC[0m). The base64 payload
// has no reliable self-delimiter, so the ESC[0m terminator is the only safe
// boundary — strip the whole concealed span FIRST, before generic ANSI codes
// are removed (otherwise the terminator is destroyed and the payload orphaned).
const CONCEALED_STEP_MARKER = /\x1b\[8m[\s\S]*?\x1b\[0m/g;
const ANSI_PATTERN = /\x1b?\[[0-9;]*m/g;
// Fallback for any `ha:////` blob that arrived without its conceal wrapper.
const PIPELINE_STEP_MARKER = /ha:\/\/\/\/[A-Za-z0-9+/]+={0,2}/g;

export function stripAnsi(text: string): string {
  return text
    .replace(CONCEALED_STEP_MARKER, "")
    .replace(ANSI_PATTERN, "")
    .replace(PIPELINE_STEP_MARKER, "");
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

// The migration script's skip notice. Server text: matched loosely (case, the
// word before the id, the version in parentheses optional).
const SAME_VERSION = /WARNING:\s*\w*\s*([0-9a-f]{32}|[0-9a-f-]{36})\s+has\s+(?:the\s+)?same\s+version\s*(?:\((\d+)\))?/i;
const WARNING_LINE = /(?:^|::\s*)WARNING:\s*(.+)$/;

/** Same-version skips and other `WARNING:` lines of a cleaned console. */
export function parseConsoleWarnings(cleanedOutput: string): { skipped: SkippedEntity[]; warnings: string[] } {
  const skipped: SkippedEntity[] = [];
  const warnings: string[] = [];
  for (const raw of cleanedOutput.split(/\r?\n/)) {
    const line = raw.trim();
    const same = SAME_VERSION.exec(line);
    if (same) {
      const id = (same[1] as string).toLowerCase();
      if (!skipped.some((s) => s.id === id)) {
        skipped.push({ id, reason: "same-version", ...(same[2] ? { version: Number(same[2]) } : {}) });
      }
      continue;
    }
    const warning = WARNING_LINE.exec(line)?.[1]?.trim();
    if (warning && !warnings.includes(warning)) warnings.push(warning);
  }
  return { skipped, warnings };
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

  const { skipped, warnings } = parseConsoleWarnings(cleanedOutput);

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
    skipped,
    warnings,
    reportSummary: summarizeReport(reportRaw),
    rawReport: reportRaw,
  };
}
