// Report ids: 32 hex characters, given bare, dashed, upper case or inside a
// Report Designer URL (the last 32-hex path segment wins).

import { CliError } from "@belzabar/core";
import { canonicalUuid, isEntityId } from "@belzabar/core/platform";

/** The `<id>` positional every report command takes. */
export const REPORT_ID_POSITIONAL = {
  name: "id",
  required: true,
  missingCode: "MISSING_REPORT_ID",
  missingMessage: "Missing <id> argument (a report id or Report Designer URL).",
} as const;

export function parseReportId(input: string): string {
  const raw = input.trim();
  let candidate = raw;
  if (/^https?:\/\//i.test(raw)) {
    const path = raw.replace(/[?#].*$/, "").split("/").filter(Boolean);
    candidate = [...path].reverse().find((seg) => isEntityId(seg)) ?? "";
  }
  if (isEntityId(candidate)) return canonicalUuid(candidate);
  throw new CliError(`Not a report id or Report Designer URL: '${raw}'. Expected 32 hex characters.`, {
    code: "RD_INVALID_ID",
    details: { input: raw },
  });
}
