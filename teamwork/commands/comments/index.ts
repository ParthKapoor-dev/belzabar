import { CliError, ok } from "@belzabar/core";
import type { CommandModule, CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { fetchComments } from "../../lib/api";
import type { TeamworkComment } from "../../lib/types";

interface GetCommentsArgs {
  taskId: number;
}

interface GetCommentsData {
  taskId: number;
  comments: TeamworkComment[];
  total: number;
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

export const schema = "tw.comments";
export const version = "1.0";

export function parseArgs(args: string[], _context: CommandContext): GetCommentsArgs {
  if (args.length === 0) {
    throw new CliError("Missing required argument: <taskId|url>", { code: "MISSING_ARG" });
  }
  return { taskId: parseTaskId(args[0]!) };
}

export async function execute(args: GetCommentsArgs, _context: CommandContext): Promise<CommandResult<GetCommentsData>> {
  const comments = await fetchComments(args.taskId);
  return ok({
    taskId: args.taskId,
    comments,
    total: comments.length,
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function compactMessage(body: string, maxLen: number): string {
  // Collapse whitespace/newlines into single spaces for compact table display
  const oneLine = body.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
}

export function presentHuman(envelope: CommandEnvelope<GetCommentsData>, ui: HumanPresenterHelpers): void {
  const { taskId, comments, total } = envelope.data!;

  ui.success(`Fetched ${total} comment${total !== 1 ? "s" : ""} for task #${taskId}`);

  if (comments.length === 0) {
    ui.info("No comments found.");
    return;
  }

  // Summary table — compact, one row per comment
  ui.section("Comments");
  ui.table(
    ["#", "Author", "Date", "Message"],
    comments.map((c, i) => [
      i + 1,
      c.postedByName,
      formatDate(c.postedDateTime),
      compactMessage(c.body, 80) + (c.fileCount > 0 ? ` [${c.fileCount} file${c.fileCount > 1 ? "s" : ""}]` : ""),
    ]),
  );

  // Full comment bodies below the table
  ui.section("Full Comments");
  for (const [i, c] of comments.entries()) {
    ui.text(`\n--- #${i + 1} | ${c.postedByName} | ${formatDate(c.postedDateTime)} ---`);
    ui.text(c.body.trim());
  }
}
