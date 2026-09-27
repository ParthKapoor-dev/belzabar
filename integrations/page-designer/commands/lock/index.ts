// belz pd lock <action> <pageId>
//
// Actions:
//   acquire <pageId>   PUT /pages/lock/<pageId> body {pageLockAction:"ACQUIRED"}
//   release <pageId>   PUT /pages/lock/<pageId>?pageLockAction=RELEASED
//   status             List locks currently held by this belz process (local).
//
// Acquired locks are tracked in ~/.belz/pd-locks/<env>.json so subsequent
// commands can warn on stale locks. The server is the source of truth for
// *ownership*; this file is only a reminder for the operator.

import { join } from "node:path";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { BELZ_CONFIG_DIR, CliError, Config, defineSubcommands, ok, type CommandModule } from "@belzabar/core";
import { pdApi } from "../../lib/api/index";

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
}
interface LockStatusData {
  action: "status";
  env: string;
  locks: Array<{ pageId: string; acquiredAt: number; acquiredAtIso: string }>;
}
type LockData = LockAcquireData | LockReleaseData | LockStatusData;

interface LockFile {
  locks: Record<string, { acquiredAt: number }>;
}

async function lockFilePath(): Promise<{ dir: string; file: string; env: string }> {
  // Per-env lock file (PD-9): `Config.env` never existed, so every env shared default.json.
  const env = Config.activeEnv?.name || "default";
  const dir = join(BELZ_CONFIG_DIR, "pd-locks");
  const file = join(dir, `${env}.json`);
  return { dir, file, env };
}

async function loadLockFile(): Promise<{ env: string; data: LockFile; file: string }> {
  const { dir, file, env } = await lockFilePath();
  await mkdir(dir, { recursive: true });
  try {
    await access(file);
  } catch {
    return { env, data: { locks: {} }, file };
  }
  try {
    const body = await readFile(file, "utf8");
    const parsed = JSON.parse(body) as LockFile;
    return { env, data: parsed && typeof parsed === "object" && parsed.locks ? parsed : { locks: {} }, file };
  } catch {
    return { env, data: { locks: {} }, file };
  }
}

async function saveLockFile(file: string, data: LockFile): Promise<void> {
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

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
      await pdApi.releaseLock(args.pageId!);
      const { data, file, env } = await loadLockFile();
      delete data.locks[args.pageId!];
      await saveLockFile(file, data);
      return ok<LockReleaseData>({ action: "release", pageId: args.pageId!, env });
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
    if (!envelope.ok) return;
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
