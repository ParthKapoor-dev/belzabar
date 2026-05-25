import { CliError, ok } from "@belzabar/core";
import type { CommandContext, CommandResult, CommandEnvelope, HumanPresenterHelpers } from "@belzabar/core";
import { searchTasks } from "../../lib/api";
import type { TeamworkTaskSearchResult } from "../../lib/types";

interface SearchArgs {
  query: string;
  limit: number;
  projectId?: number;
  includeCompleted: boolean;
}

interface SearchData {
  query: string;
  results: TeamworkTaskSearchResult[];
  total: number;
}

export const schema = "tw.search";
export const version = "1.0";

export function parseArgs(args: string[], _context: CommandContext): SearchArgs {
  let limit = 25;
  let projectId: number | undefined;
  let includeCompleted = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--limit") {
      const n = parseInt(args[++i] ?? "", 10);
      if (isNaN(n) || n < 1) throw new CliError("--limit requires a positive number.", { code: "INVALID_LIMIT" });
      limit = n;
    } else if (a === "--project") {
      const n = parseInt(args[++i] ?? "", 10);
      if (isNaN(n)) throw new CliError("--project requires a numeric project id.", { code: "INVALID_PROJECT" });
      projectId = n;
    } else if (a === "--all" || a === "--include-completed") {
      includeCompleted = true;
    } else {
      positional.push(a);
    }
  }

  const query = positional.join(" ").trim();
  if (!query) {
    throw new CliError("Missing search query. Usage: belz tw search <query> [--project <id>] [--limit N] [--all]", {
      code: "MISSING_QUERY",
    });
  }
  return { query, limit, projectId, includeCompleted };
}

export async function execute(args: SearchArgs, _context: CommandContext): Promise<CommandResult<SearchData>> {
  const results = await searchTasks(args.query, {
    limit: args.limit,
    projectId: args.projectId,
    includeCompleted: args.includeCompleted,
  });
  return ok({ query: args.query, results, total: results.length });
}

export function presentHuman(envelope: CommandEnvelope<SearchData>, ui: HumanPresenterHelpers): void {
  const { query, results, total } = envelope.data!;

  ui.success(`Found ${total} task${total !== 1 ? "s" : ""} matching "${query}"`);

  if (results.length === 0) {
    ui.info("No matching tasks.");
    return;
  }

  ui.section("Tasks");
  ui.table(
    ["#", "ID", "Name", "Status", "Project", "Tasklist"],
    results.map((r, i) => [
      i + 1,
      r.id,
      r.name.length > 60 ? r.name.slice(0, 57) + "..." : r.name,
      r.status,
      r.projectName ?? "",
      r.tasklistName ?? "",
    ]),
  );
}
