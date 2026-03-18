import { CliError, ok } from "@belzabar/core";
import type { CommandModule, CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { fetchTask } from "../../lib/api";
import type { TeamworkTask } from "../../lib/types";

interface GetTaskArgs {
  taskId: number;
}

interface GetTaskData {
  task: TeamworkTask;
  url: string;
}

function parseTaskId(input: string): number {
  // Accept a bare numeric ID or a full URL like https://projects.webintensive.com/app/tasks/26917411
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

export const schema = "tw.task";
export const version = "1.0";

export function parseArgs(args: string[], _context: CommandContext): GetTaskArgs {
  if (args.length === 0) {
    throw new CliError("Missing required argument: <taskId|url>", { code: "MISSING_ARG" });
  }
  return { taskId: parseTaskId(args[0]!) };
}

export async function execute(args: GetTaskArgs, _context: CommandContext): Promise<CommandResult<GetTaskData>> {
  const task = await fetchTask(args.taskId);
  return ok({
    task,
    url: `https://projects.webintensive.com/app/tasks/${args.taskId}`,
  });
}

function formatTime(minutes: number): string {
  if (minutes === 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function presentHuman(envelope: CommandEnvelope<GetTaskData>, ui: HumanPresenterHelpers): void {
  const { task, url } = envelope.data!;

  ui.success(`Fetched task #${task.id}`);

  // ── Task Summary Table ──
  ui.section("Task Summary");
  ui.table(
    ["Property", "Value"],
    [
      ["Task Name", task.name],
      ["ID", task.id],
      ["Status", task.status],
      ["Workflow Stage", task.workflowStage ?? ""],
      ["Project", task.projectName ?? ""],
      ["Tasklist", task.tasklistName ?? ""],
      ["Parent Task", task.parentTaskName ? `${task.parentTaskName} (#${task.parentTaskId})` : ""],
      ["Due Date", formatDate(task.dueDate)],
      ["Start Date", formatDate(task.startDate)],
      ["Progress", `${task.progress}%`],
      ["Priority", task.priority ?? "None"],
      ["Time Logged", formatTime(task.loggedMinutes)],
      ["Estimate", formatTime(task.estimateMinutes)],
      ["Comments", task.commentStats ? `${task.commentStats.total} (${task.commentStats.read} read)` : "0"],
      ["URL", url],
    ],
  );

  // ── Assignees Table ──
  if (task.assignees.length > 0) {
    ui.section("Assignees");
    ui.table(
      ["#", "Name", "Email"],
      task.assignees.map((a, i) => [i + 1, `${a.firstName} ${a.lastName}`, a.email]),
    );
  }

  // ── Tags Table ──
  if (task.tags.length > 0) {
    ui.section("Tags");
    ui.table(
      ["#", "Tag", "Color"],
      task.tags.map((t, i) => [i + 1, t.name, t.color]),
    );
  }

  // ── Description ──
  if (task.description) {
    ui.section("Description");
    const truncated = task.description.length > 800
      ? task.description.slice(0, 800) + "..."
      : task.description;
    ui.text(truncated);
  }
}
