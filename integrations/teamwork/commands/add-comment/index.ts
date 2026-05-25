import { CliError, ok } from "@belzabar/core";
import type { CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { addComment, fetchTask } from "../../lib/api";
import { requireConfirmation, logIntent } from "../../lib/confirm";

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

function parseTaskId(input: string): number {
  const urlMatch = input.match(/\/tasks\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1]!, 10);

  const num = parseInt(input, 10);
  if (isNaN(num)) {
    throw new CliError(`Invalid task ID: '${input}'. Provide a numeric ID or Teamwork task URL.`, {
      code: "INVALID_TASK_ID",
    });
  }
  return num;
}

export const schema = "tw.add-comment";
export const version = "1.0";

export function parseArgs(args: string[], _context: CommandContext): AddCommentArgs {
  let body: string | undefined;
  let bodyFile: string | undefined;
  let contentType: "TEXT" | "HTML" = "TEXT";
  let yes = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--body") body = args[++i];
    else if (a === "--body-file") bodyFile = args[++i];
    else if (a === "--html") contentType = "HTML";
    else if (a === "--yes" || a === "-y") yes = true;
    else positional.push(a);
  }

  if (positional.length === 0) {
    throw new CliError('Missing <taskId|url>. Usage: belz tw add-comment <taskId|url> --body "<text>"', {
      code: "MISSING_ARG",
    });
  }
  if (body === undefined && bodyFile === undefined) {
    throw new CliError('Missing comment text. Pass --body "<text>" or --body-file <path>.', {
      code: "MISSING_BODY",
    });
  }

  return { taskId: parseTaskId(positional[0]!), body, bodyFile, contentType, yes };
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

  await requireConfirmation({
    yes: args.yes,
    outputMode: context.outputMode,
    action: `post a comment to Teamwork task ${taskName}`,
    details: [
      ["Task", taskName],
      ["Format", args.contentType],
      ["Comment", body],
    ],
  });

  logIntent("POST", `/projects/api/v3/tasks/${args.taskId}/comments.json`, { taskId: args.taskId });
  const result = await addComment(args.taskId, body, { contentType: args.contentType });

  return ok({
    taskId: args.taskId,
    commentId: result.id,
    body,
    contentType: args.contentType,
    url: `https://projects.webintensive.com/app/tasks/${args.taskId}`,
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
