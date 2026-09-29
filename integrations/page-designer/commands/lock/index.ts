// belz pd lock <action> <pageId>
//
// Actions:
//   acquire <pageId>   PUT /pages/lock/<pageId>?pageLockAction=ACQUIRED
//   release <pageId>   PUT /pages/lock/<pageId>?pageLockAction=RELEASED
//   status             List locks this belz user acquired manually (local record).
//
// Acquired locks are recorded in ~/.belz/pd-locks/<env>.json (atomic, 0600).
// `withLock` (every save/publish/restore) still acquires the server lock for a
// recorded page (OTH-R4: the record can be stale) but does not release it
// afterwards (PD-20). The server is the source of truth for ownership; the
// file is only a reminder for the operator. A release that fails with a 5xx
// keeps the record (OTH-R9: the lock may still be ours); a 4xx refusal means
// we do not hold it, so the record goes.

import { defineSubcommands, failWithData, ok, type CommandModule } from "@belzabar/core";
import { pdApi } from "../../lib/api/index";
import { loadLockFile, saveLockFile } from "../../lib/lock";

type Action = "acquire" | "release" | "status";

interface LockArgs {
  action: Action;
  pageId: string | null;
}

interface LockAcquireData {
  action: "acquire";
  pageId: string;
  env: string;
  acquiredAt: number;
}
interface LockReleaseData {
  action: "release";
  pageId: string;
  env: string;
  /** The server accepted the release (PD-20: it used to always "succeed"). */
  released: boolean;
  httpStatus: number;
  /** The local record was kept because the outcome is unknown (5xx, OTH-R9). */
  recordKept: boolean;
}
interface LockStatusData {
  action: "status";
  env: string;
  locks: Array<{ pageId: string; acquiredAt: number; acquiredAtIso: string }>;
}
type LockData = LockAcquireData | LockReleaseData | LockStatusData;

const PAGE_ID = {
  name: "page-id",
  required: true,
  missingCode: "MISSING_INPUT",
  missingMessage: "Missing <pageId>.",
} as const;

export const args = defineSubcommands(
  {
    acquire: { positionals: [PAGE_ID] },
    release: { positionals: [PAGE_ID] },
    status: {},
  },
  {
    command: "belz pd lock",
    codes: { MISSING_SUBCOMMAND: "MISSING_ACTION", UNKNOWN_SUBCOMMAND: "UNKNOWN_ACTION" },
  },
);

const command: CommandModule<LockArgs, LockData> = {
  schema: "pd.lock",
  writes: (a: LockArgs) => a.action !== "status",

  parseArgs(argv) {
    const r = args.parse(argv);
    return { action: r.subcommand, pageId: r.subcommand === "status" ? null : r.positionals.pageId };
  },

  async execute(args) {
    if (args.action === "acquire") {
      await pdApi.acquireLock(args.pageId!);
      const { data, file, env } = await loadLockFile();
      const acquiredAt = Date.now();
      data.locks[args.pageId!] = { acquiredAt };
      await saveLockFile(file, data);
      return ok<LockAcquireData>({ action: "acquire", pageId: args.pageId!, env, acquiredAt });
    }
    if (args.action === "release") {
      const status = await pdApi.releaseLockStatus(args.pageId!);
      const released = status < 300;
      const { data, file, env } = await loadLockFile();
      // OTH-R9: only a definite answer drops the record. 2xx = released; 4xx =
      // refused (not ours / already gone), so we do not hold it either way.
      // A 5xx leaves the outcome unknown: keep the record so `status` shows it.
      const recordKept = status >= 500 && args.pageId! in data.locks;
      if (!recordKept && args.pageId! in data.locks) {
        delete data.locks[args.pageId!];
        await saveLockFile(file, data);
      }
      const out: LockReleaseData = { action: "release", pageId: args.pageId!, env, released, httpStatus: status, recordKept };
      if (!released) {
        return failWithData(
          "PD_LOCK_RELEASE_FAILED",
          recordKept
            ? `The lock release on ${args.pageId} failed with HTTP ${status}; the lock may still be held — the local record is kept, retry later.`
            : `The server refused to release the lock on ${args.pageId} (held by another session, or already released).`,
          out,
        );
      }
      return ok(out);
    }
    // status
    const { data, env } = await loadLockFile();
    const locks = Object.entries(data.locks).map(([pageId, info]) => ({
      pageId,
      acquiredAt: info.acquiredAt,
      acquiredAtIso: new Date(info.acquiredAt).toISOString(),
    }));
    return ok<LockStatusData>({ action: "status", env, locks });
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok || !envelope.data) return;
    const data = envelope.data as LockData;
    if (data.action === "acquire") {
      ui.success(`Acquired lock on ${data.pageId} (env=${data.env}).`);
      ui.info("Remember to `belz pd lock release <id>` when done — stale locks block other editors.");
      return;
    }
    if (data.action === "release") {
      ui.success(`Released lock on ${data.pageId} (env=${data.env}).`);
      return;
    }
    ui.kv("Env", data.env);
    if (data.locks.length === 0) {
      ui.text("No locks held by belz in this environment.");
      return;
    }
    ui.table(
      ["Page", "Acquired At"],
      data.locks.map((l) => [l.pageId, l.acquiredAtIso]),
    );
  },
};

export default command;
