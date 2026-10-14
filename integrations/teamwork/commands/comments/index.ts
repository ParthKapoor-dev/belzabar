import { defineArgs, ok } from "@belzabar/core";
import { parseTaskId, TASK_ID_POSITIONAL } from "../../lib/task-id";
import type { CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
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

export const args = defineArgs({
  command: "wi-impl tw comments",
  positionals: [TASK_ID_POSITIONAL],
});

export function parseArgs(argv: string[], _context?: CommandContext): GetCommentsArgs {
  const { positionals } = args.parse(argv);
  return { taskId: parseTaskId(positionals.taskId) };
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
