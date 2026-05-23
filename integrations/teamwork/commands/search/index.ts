import { CliError, ok } from "@belzabar/core";
import type { CommandModule, CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { searchTasks } from "../../lib/api";
import type { TeamworkTaskSummary } from "../../lib/types";

interface SearchArgs {
  query: string;
  projectId?: number;
  status?: string;
}

interface SearchData {
  query: string;
  total: number;
  tasks: TeamworkTaskSummary[];
}

export const schema = "tw.search";
export const version = "1.0";

export function parseArgs(args: string[], _context: CommandContext): SearchArgs {
  const positional: string[] = [];
  let projectId: number | undefined;
  let status: string | undefined;

  function parseProject(value: string | undefined): number {
    if (value === undefined || value.startsWith("-")) {
      throw new CliError("`--project` requires a numeric project id.", { code: "MISSING_FLAG_VALUE" });
    }
    const num = parseInt(value, 10);
    if (isNaN(num)) {
      throw new CliError(`Invalid project id: '${value}'. Provide a numeric Teamwork project id.`, { code: "INVALID_PROJECT_ID" });
    }
    return num;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project" || arg === "--project-id") {
      projectId = parseProject(args[i + 1]);
      i++;
      continue;
    }
    if (arg.startsWith("--project=")) {
      projectId = parseProject(arg.slice("--project=".length));
      continue;
    }
    if (arg === "--status") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliError("`--status` requires a value.", { code: "MISSING_FLAG_VALUE" });
      }
      status = value;
      i++;
      continue;
    }
    if (arg.startsWith("--status=")) {
      status = arg.slice("--status=".length);
      continue;
    }
    positional.push(arg);
  }

  const query = positional.join(" ").trim();
  if (!query) {
    throw new CliError("Missing required argument: <query>", { code: "MISSING_ARG" });
  }
  return { query, projectId, status };
}

export async function execute(args: SearchArgs, _context: CommandContext): Promise<CommandResult<SearchData>> {
  const tasks = await searchTasks(args.query, { projectId: args.projectId, status: args.status });
  return ok({ query: args.query, total: tasks.length, tasks });
}

export function presentHuman(envelope: CommandEnvelope<SearchData>, ui: HumanPresenterHelpers): void {
  const { query, total, tasks } = envelope.data!;

  ui.success(`Found ${total} task${total !== 1 ? "s" : ""} matching "${query}"`);

  if (tasks.length === 0) {
    ui.info("No matching tasks.");
    return;
  }

  ui.section("Tasks");
  ui.table(
    ["#", "ID", "Name", "Project", "Status", "Assignees"],
    tasks.map((t, i) => [
      i + 1,
      t.id,
      t.name,
      t.projectName ?? "—",
      t.status || "—",
      t.assignees.map((a) => `${a.firstName} ${a.lastName}`.trim()).join(", ") || "—",
    ]),
  );
}
