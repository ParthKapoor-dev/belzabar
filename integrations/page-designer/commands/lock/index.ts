// wi-impl pd lock <action> <pageId>
//
// Actions:
//   acquire <pageId>   PUT /pages/lock/<pageId>?pageLockAction=ACQUIRED
//   release <pageId>   PUT /pages/lock/<pageId>?pageLockAction=RELEASED
//   status [pageId]    List locks this wi-impl user acquired manually (local record);
//                      with a page id, also the server's lock on it.
//
// Acquired locks are recorded in ~/.wi-impl/pd-locks/<env>.json (atomic, 0600).
// `withLock` (every save/publish/restore) still acquires the server lock for a
// recorded page (the record can be stale); the server answers a
// re-acquire of your own lock with HTTP 400, which wi-impl recognises through
// the page's `pageLockDetails.lockedByCurrentUser` and writes inside the
// lock without releasing it. `acquire` on a lock you already
// hold is ok with `alreadyHeld: true`. A release answers 200 `true` (released)
// or 200 `false` (nothing of yours was held); a 5xx keeps the record.
// `status <pageId>` also reads the server's view of that page's lock.

import { defineSubcommands, failWithData, ok, type CommandModule } from "@belzabar/core";
import { pdApi } from "../../lib/api/index";
import { lockHolder } from "../../lib/api/client";
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
  /** You already held the server lock (nothing changed server-side). */
  alreadyHeld: boolean;
}
interface LockReleaseData {
  action: "release";
  pageId: string;
  env: string;
  /** The server released a lock of yours; false = nothing of yours was held / refused; null = unknown (5xx). */
  released: boolean | null;
  httpStatus: number;
  /** The local record was kept because the outcome is unknown (5xx). */
  recordKept: boolean;
}
interface LockStatusData {
  action: "status";
  env: string;
  locks: Array<{ pageId: string; acquiredAt: number; acquiredAtIso: string }>;
  /** `status <pageId>`: the server's view of that page's lock. */
  server?: {
    pageId: string;
    locked: boolean;
    byMe: boolean | null;
    userName: string | null;
    userId: number | null;
    validTill: string | null;
  };
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
    status: { positionals: [{ name: "page-id" }] },
  },
  {
    command: "wi-impl pd lock",
    codes: { MISSING_SUBCOMMAND: "MISSING_ACTION", UNKNOWN_SUBCOMMAND: "UNKNOWN_ACTION" },
  },
);

const command: CommandModule<LockArgs, LockData> = {
  writes: (a: LockArgs) => a.action !== "status",

  parseArgs(argv) {
    const r = args.parse(argv);
    return { action: r.subcommand, pageId: r.positionals.pageId ?? null };
  },

  async execute(args) {
    if (args.action === "acquire") {
      const outcome = await pdApi.acquireLock(args.pageId!);
      const { data, file, env } = await loadLockFile();
      const acquiredAt = Date.now();
      data.locks[args.pageId!] = { acquiredAt };
      await saveLockFile(file, data);
      return ok<LockAcquireData>({ action: "acquire", pageId: args.pageId!, env, acquiredAt, alreadyHeld: !outcome.acquired });
    }
    if (args.action === "release") {
      const { status, released } = await pdApi.releaseLock(args.pageId!);
      const { data, file, env } = await loadLockFile();
      // Only a definite answer drops the record (released, or the
      // server says nothing of ours was held). A 5xx leaves the outcome
      // unknown: keep the record so `status` shows it.
      const recordKept = released === null && args.pageId! in data.locks;
      if (!recordKept && args.pageId! in data.locks) {
        delete data.locks[args.pageId!];
        await saveLockFile(file, data);
      }
      const out: LockReleaseData = { action: "release", pageId: args.pageId!, env, released, httpStatus: status, recordKept };
      if (released !== true) {
        return failWithData(
          "PD_LOCK_RELEASE_FAILED",
          released === null
            ? `The lock release on ${args.pageId} failed with HTTP ${status}; the lock may still be held — the local record is kept, retry later.`
            : `The server released nothing on ${args.pageId}: you do not hold its lock (already released, expired, or held by someone else).`,
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
    const out: LockStatusData = { action: "status", env, locks };
    if (args.pageId) {
      const d = await pdApi.fetchLockDetails(args.pageId);
      const locked = !!d && (d.status === undefined || d.status === "ACQUIRED");
      out.server = {
        pageId: args.pageId,
        locked,
        byMe: locked && d ? d.lockedByCurrentUser === true : null,
        ...(locked && d ? lockHolder(d) : { userName: null, userId: null, validTill: null }),
      };
    }
    return ok<LockStatusData>(out);
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok || !envelope.data) return;
    const data = envelope.data as LockData;
    if (data.action === "acquire") {
      ui.success(`${data.alreadyHeld ? "You already hold the lock" : "Acquired lock"} on ${data.pageId} (env=${data.env}).`);
      ui.info("Remember to `wi-impl pd lock release <id>` when done — stale locks block other editors.");
      return;
    }
    if (data.action === "release") {
      ui.success(`Released lock on ${data.pageId} (env=${data.env}).`);
      return;
    }
    ui.kv("Env", data.env);
    if (data.server) {
      const s = data.server;
      ui.kv(
        `Server lock on ${s.pageId}`,
        s.locked ? `held by ${s.byMe ? "you" : s.userName ?? `user ${s.userId ?? "?"}`}${s.validTill ? ` until ${s.validTill}` : ""}` : "free",
      );
    }
    if (data.locks.length === 0) {
      ui.text("No locks held by wi-impl in this environment.");
      return;
    }
    ui.table(
      ["Page", "Acquired At"],
      data.locks.map((l) => [l.pageId, l.acquiredAtIso]),
    );
  },
};

export default command;
