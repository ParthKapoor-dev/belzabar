import { CliError, defineArgs, ok } from "@belzabar/core";
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

export const args = defineArgs({
  command: "belz tw search",
  positionals: [
    { name: "query", variadic: true }, // required: checked below (keeps the MISSING_QUERY code)
  ],
  flags: {
    // TW-2: Teamwork rejects pageSize > 500 with a 400.
    limit: { type: "number", integer: true, min: 1, max: 500, default: 25 },
    project: { type: "number", integer: true, min: 1 },
    all: { type: "boolean", alias: ["--include-completed"] },
  },
});

export function parseArgs(argv: string[], _context?: CommandContext): SearchArgs {
  const { positionals, flags } = args.parse(argv);
  const query = positionals.query.join(" ").trim();
  if (!query) {
    throw new CliError("Missing search query. Usage: belz tw search <query> [--project <id>] [--limit N] [--all]", {
      code: "MISSING_QUERY",
    });
  }
  return { query, limit: flags.limit, projectId: flags.project, includeCompleted: flags.all };
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
