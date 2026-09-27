// One task-id validator for every `belz tw` command and `belz release matrix` (TW-6).
//
// Accepts a bare positive integer or a Teamwork task URL (`…/tasks/<id>`).
// `parseInt` used to accept `123abc` and `-5`, which then 404'd as UNHANDLED.

import { CliError } from "@belzabar/core";

export function parseTaskId(input: string): number {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/tasks\/(\d+)(?:[/?#]|$)/);
  const digits = urlMatch ? urlMatch[1]! : /^\d+$/.test(trimmed) ? trimmed : null;
  const n = digits === null ? NaN : Number(digits);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new CliError(`Invalid task ID: '${input}'. Provide a positive numeric ID or a Teamwork task URL.`, {
      code: "INVALID_TASK_ID",
      details: { input },
    });
  }
  return n;
}

/** The `<taskId|url>` positional shared by tw commands. */
export const TASK_ID_POSITIONAL = {
  name: "task-id",
  required: true,
  missingCode: "MISSING_ARG",
  missingMessage: "Missing required argument: <taskId|url>",
} as const;
