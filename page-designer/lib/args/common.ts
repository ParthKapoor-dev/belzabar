// Shared argument parser for every PD command.
//
// Strips belz's common PD flags (--force, --yes, --dry-run) out of argv and
// hands back the remainder for the command's own parser to consume. --env and
// --llm are stripped upstream in packages/core/runner.ts.
//
// PD has no V1/V2 distinction, so unlike the AD equivalent there is no API
// version resolution here — just the gate flags that every write and preflight
// command needs.

export interface PdCommonArgs {
  force: boolean;
  yes: boolean;
  dryRun: boolean;
}

export interface ParsedPdArgs {
  common: PdCommonArgs;
  rest: string[];
}

/**
 * Strip PD common flags from argv.
 *   --force     bypass validator errors on write paths (banner printed)
 *   --yes       skip interactive confirmation (required in --llm mode)
 *   --dry-run   run the full flow but skip the network PUT
 */
export function parsePdCommonArgs(argv: string[]): ParsedPdArgs {
  const rest: string[] = [];
  let force = false;
  let yes = false;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    rest.push(arg);
  }

  return { common: { force, yes, dryRun }, rest };
}
