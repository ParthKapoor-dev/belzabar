// When a migration build reports a FAILED entity without a reason (the
// report row says FAILED, the console has no `FAILED ITEM` line), the reason
// is only in the migration service's status: the job's *_MIGRATION_STATUS
// module prints it. `migrate run` triggers that build itself and reads the
// `FAILED ITEM` lines from its console.

import type { JenkinsAuth, TriggerBuildInput } from "./jenkins";
import { buildUrl, resolveQueueItem, streamConsole, triggerBuild } from "./jenkins";
import { parseJenkinsConsole } from "./parser";
import type { FailedItem, StatusBuildRef } from "./types";

/** The status module for a migration module (`PD` → `PD_MIGRATION_STATUS`, `AD_Method` → `AD_MIGRATION_STATUS`). */
export function statusModuleFor(migrateType: string): string | null {
  if (/^PD$/i.test(migrateType)) return "PD_MIGRATION_STATUS";
  if (/^AD_(Method|Service)$/i.test(migrateType)) return "AD_MIGRATION_STATUS";
  return null;
}

/**
 * Trigger a status build for `migrationId` and return the failure lines of its
 * console. Never throws: a failure is `ref.error`.
 */
export async function readFailureReasons(
  auth: JenkinsAuth,
  base: Pick<TriggerBuildInput, "client" | "profile" | "devopsTag">,
  module: string,
  migrationId: string,
  ids: string[],
  opts: { onProgress?: (line: string) => void } = {},
): Promise<{ ref: StatusBuildRef; items: FailedItem[] }> {
  const ref: StatusBuildRef = { module };
  try {
    const trigger = await triggerBuild(auth, {
      ...base,
      migrateType: module,
      ids,
      migrationId,
      asyncMigration: "N",
      migrateDependent: "N",
      autoApprove: true,
    });
    const queue = await resolveQueueItem(auth, trigger.queueUrl);
    ref.buildNumber = queue.executable?.number as number;
    ref.buildUrl = buildUrl(auth, ref.buildNumber);
    opts.onProgress?.(`Status build #${ref.buildNumber} started: ${ref.buildUrl}`);
    const stream = await streamConsole(auth, ref.buildNumber);
    ref.result = stream.result;
    const items = parseJenkinsConsole(stream.consoleText).failedItems;
    if (items.length === 0) ref.error = "the status build printed no FAILED ITEM line";
    return { ref, items };
  } catch (e) {
    ref.error = e instanceof Error ? e.message : String(e);
    return { ref, items: [] };
  }
}
