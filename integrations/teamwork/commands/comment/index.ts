import { CliError, ok } from "@belzabar/core";
import type { CommandModule, CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { addComment } from "../../lib/api";

interface CommentArgs {
  taskId: number;
  body?: string;
  bodyFile?: string;
}

interface CommentData {
  taskId: number;
  commentId: number;
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

export const schema = "tw.comment";
export const version = "1.0";

export function parseArgs(args: string[], _context: CommandContext): CommentArgs {
  const positional: string[] = [];
  let body: string | undefined;
  let bodyFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--body") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError("`--body` requires a comment message.", { code: "MISSING_FLAG_VALUE" });
      }
      body = value;
      i++;
      continue;
    }
    if (arg.startsWith("--body=")) {
      body = arg.slice("--body=".length);
      continue;
    }
    if (arg === "--body-file") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliError("`--body-file` requires a file path.", { code: "MISSING_FLAG_VALUE" });
      }
      bodyFile = value;
      i++;
      continue;
    }
    if (arg.startsWith("--body-file=")) {
      bodyFile = arg.slice("--body-file=".length);
      continue;
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    throw new CliError("Missing required argument: <taskId|url>", { code: "MISSING_ARG" });
  }
  if (body !== undefined && bodyFile !== undefined) {
    throw new CliError("Pass either --body or --body-file, not both.", { code: "CONFLICTING_FLAGS" });
  }
  if (body === undefined && bodyFile === undefined) {
    throw new CliError("A comment body is required. Pass --body \"<text>\" or --body-file <path>.", {
      code: "MISSING_BODY",
    });
  }

  return { taskId: parseTaskId(positional[0]!), body, bodyFile };
}

export async function execute(args: CommentArgs, _context: CommandContext): Promise<CommandResult<CommentData>> {
  let body = args.body;
  if (args.bodyFile) {
    const file = Bun.file(args.bodyFile);
    if (!(await file.exists())) {
      throw new CliError(`Comment body file not found: ${args.bodyFile}`, { code: "BODY_FILE_NOT_FOUND" });
    }
    body = await file.text();
  }

  if (!body || body.trim().length === 0) {
    throw new CliError("Comment body is empty.", { code: "EMPTY_BODY" });
  }

  // Audit log only — this command posts immediately. The caller is responsible
  // for validating the exact comment text with the user before invoking it.
  process.stderr.write(
    `[belz tw write] ${JSON.stringify({ ts: new Date().toISOString(), method: "POST", path: `/tasks/${args.taskId}/comments`, bytes: body.length })}\n`,
  );

  const commentId = await addComment(args.taskId, body);

  return ok({
    taskId: args.taskId,
    commentId,
    url: `https://projects.webintensive.com/app/tasks/${args.taskId}`,
  });
}

export function presentHuman(envelope: CommandEnvelope<CommentData>, ui: HumanPresenterHelpers): void {
  const { taskId, commentId, url } = envelope.data!;
  ui.success(`Posted comment ${commentId} on task #${taskId}`);
  ui.kv("Task", url);
}
