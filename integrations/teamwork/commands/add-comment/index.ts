import { CliError, confirmWrite, defineArgs, logWriteIntent, ok } from "@belzabar/core";
import { parseTaskId, TASK_ID_POSITIONAL } from "../../lib/task-id";
import type { CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { addComment, fetchTask } from "../../lib/api";
import { teamworkTaskUrl } from "../../lib/auth";

interface AddCommentArgs {
  taskId: number;
  body?: string;
  bodyFile?: string;
  contentType: "TEXT" | "HTML";
  yes: boolean;
}

interface AddCommentData {
  taskId: number;
  commentId: number;
  body: string;
  contentType: string;
  url: string;
}

export const args = defineArgs({
  command: "belz tw add-comment",
  positionals: [
    { ...TASK_ID_POSITIONAL, missingMessage: 'Missing <taskId|url>. Usage: belz tw add-comment <taskId|url> --body "<text>"' },
  ],
  flags: {
    // `--body --yes` is MISSING_VALUE, never a comment reading "--yes".
    body: { type: "string" },
    "body-file": { type: "string" },
    html: { type: "boolean" },
    yes: { type: "boolean", alias: ["-y"] },
  },
  exclusive: [["body", "body-file"]],
  requireOneOf: [["body", "body-file"]],
});

/**
 * Posting a comment changes the ticket. Declared for the record only: `tw` is
 * not env-aware (NOT_ENV_AWARE_NAMESPACES), so the runner's explicit-`--env`
 * write gate does NOT apply here. The only guard is the confirmation in
 * execute (--yes / TTY prompt; --llm without --yes refuses).
 */
export const writes = true;

export function parseArgs(argv: string[], _context?: CommandContext): AddCommentArgs {
  const { positionals, flags } = args.parse(argv);
  return {
    taskId: parseTaskId(positionals.taskId),
    body: flags.body,
    bodyFile: flags.bodyFile,
    contentType: flags.html ? "HTML" : "TEXT",
    yes: flags.yes,
  };
}

export async function execute(args: AddCommentArgs, context: CommandContext): Promise<CommandResult<AddCommentData>> {
  let body = args.body ?? "";
  if (args.bodyFile) {
    const f = Bun.file(args.bodyFile);
    if (!(await f.exists())) {
      throw new CliError(`--body-file not found: ${args.bodyFile}`, { code: "BODY_FILE_NOT_FOUND" });
    }
    body = await f.text();
  }
  body = body.trim();
  if (!body) {
    throw new CliError('Comment body is empty. Pass --body "<text>" or --body-file <path>.', { code: "EMPTY_BODY" });
  }

  // Fetch the task name for the confirmation context (read-only, non-fatal).
  let taskName = `#${args.taskId}`;
  try {
    const t = await fetchTask(args.taskId);
    taskName = `${t.name} (#${t.id})`;
  } catch {
    /* keep the bare id if the task lookup fails */
  }

  // --yes is for an agent that has already shown the EXACT comment text to the
  // user and had it approved in chat; a prior go-ahead never counts.
  const action = `post a comment to Teamwork task ${taskName}`;
  await confirmWrite({
    yes: args.yes,
    outputMode: context.outputMode,
    action,
    details: [
      ["Task", taskName],
      ["Format", args.contentType],
      ["Comment", body],
    ],
    codePrefix: "TW",
    requiredMessage: `Confirmation required to ${action}. Pass --yes to proceed — but only after the EXACT comment text has been validated by the user in chat.`,
    promptMessage: "Post this comment?",
  });

  const path = `/projects/api/v3/tasks/${args.taskId}/comments.json`;
  logWriteIntent("tw", { method: "POST", path }, { taskId: args.taskId });
  const result = await addComment(args.taskId, body, { contentType: args.contentType });

  return ok({
    taskId: args.taskId,
    commentId: result.id,
    body,
    contentType: args.contentType,
    url: teamworkTaskUrl(args.taskId),
  });
}

export function presentHuman(envelope: CommandEnvelope<AddCommentData>, ui: HumanPresenterHelpers): void {
  const { taskId, commentId, url } = envelope.data!;
  ui.success(`Posted comment${commentId ? ` #${commentId}` : ""} to task #${taskId}`);
  ui.table(
    ["Property", "Value"],
    [
      ["Task", `#${taskId}`],
      ["Comment ID", commentId || "(unknown)"],
      ["URL", url],
    ],
  );
}
