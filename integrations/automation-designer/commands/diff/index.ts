import { CliError, Config, defineArgs, ok, type CommandModule, type CommandResult } from "@belzabar/core";
import { spawn as nodeSpawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adApi,
  type MethodVersionSummary,
} from "../../lib/api/index";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";
import { diffPaths, methodDiffView, parseVersionBody } from "../../lib/fingerprint";
import { getVersionOf } from "../../lib/history";
import { resolveMethodRef } from "../../lib/ids";
import { traceEnvFamily } from "../../lib/trace";
import type { HydratedMethod } from "../../lib/types/common";
import {
  loadOrBuildMethodFinderIndex,
  type MethodFinderMethod,
} from "../../lib/method-finder";

type Mode = "history" | "cross-env";

interface DiffArgs {
  mode: Mode;
  uuid?: string;
  from?: number;
  to?: number;
  fromEnv?: string;
  toEnv?: string;
  clean: boolean;
  /** --editor as given; null = the default (zed in human mode, none in --llm). */
  editor: string | null;
  noEditor: boolean;
}

interface DiffSide {
  label: string;
  path: string;
}

interface DiffData {
  mode: Mode;
  uuid: string;
  left: DiffSide;
  right: DiffSide;
  /**
   * The editor that was launched; null with --no-editor, in --llm without
   * --editor, or when the editor could not be started (a warning says why).
   * Both sides are always written to disk.
   */
  editor: string | null;
  /** true: the files hold the semantic diff view; false (--raw): the full parsed method. */
  cleaned: boolean;
  /** Whether the two sides' logic differs (semantic view: decoded code/SQL/SpEL, contract). */
  changed: boolean;
  /** JSON paths (in the semantic view) that differ, capped at 200. */
  differences: string[];
}

export const args = defineArgs({
  command: "belz ad diff",
  positionals: [{ name: "uuid" }],
  flags: {
    ...AD_COMMON_FLAGS,
    "cross-env": { type: "boolean" },
    from: { type: "number", integer: true, min: 1 },
    to: { type: "number", integer: true, min: 1 },
    "from-env": { type: "string" },
    "to-env": { type: "string" },
    clean: { type: "boolean" },
    raw: { type: "boolean" },
    "no-editor": { type: "boolean" },
    editor: { type: "string" },
  },
});

const command: CommandModule<DiffArgs, DiffData> = {
  schema: "ad.diff",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "list", "diff"); // diff is V1-only: --v2 prints the fallback notice
    const mode: Mode = flags.crossEnv || flags.fromEnv || flags.toEnv ? "cross-env" : "history";
    return {
      mode,
      uuid: positionals.uuid,
      from: flags.from,
      to: flags.to,
      fromEnv: flags.fromEnv,
      toEnv: flags.toEnv,
      clean: !flags.raw, // --raw overrides --clean
      editor: flags.editor ?? null,
      noEditor: flags.noEditor,
    };
  },

  async execute(args, context) {
    if (context.outputMode === "llm") {
      if (!args.uuid) {
        throw new CliError("UUID is required in --llm mode.", { code: "MISSING_UUID" });
      }
      if (args.mode === "history" && (args.from == null || args.to == null)) {
        throw new CliError(
          "--from and --to are required in --llm mode.",
          { code: "MISSING_VERSION" },
        );
      }
      if (args.mode === "cross-env" && (!args.fromEnv || !args.toEnv)) {
        throw new CliError(
          "--from-env and --to-env are required in --llm mode.",
          { code: "MISSING_ENV" },
        );
      }
    }

    const uuid = args.uuid ? resolveMethodRef(args.uuid) : await pickMethodInteractive(context);
    if (!uuid) {
      throw new CliError("No method selected.", { code: "NO_UUID_SELECTED" });
    }

    if (args.mode === "cross-env") {
      return executeCrossEnvDiff({ ...args, uuid }, context);
    }
    return executeHistoryDiff({ ...args, uuid }, context);
  },

  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as DiffData;
    ui.success(
      data.editor
        ? `Opened ${data.editor} --diff for ${data.uuid.slice(0, 8)}…`
        : `Wrote both sides for ${data.uuid.slice(0, 8)}… (no editor opened)`,
    );
    ui.table(
      ["Side", "Label", "File"],
      [
        ["left", data.left.label, data.left.path],
        ["right", data.right.label, data.right.path],
      ],
    );
    if (data.changed) {
      ui.warn(`${data.differences.length} difference(s) in the logic view:`);
      for (const p of data.differences.slice(0, 30)) ui.text(`  ${p}`);
    } else {
      ui.success("No logic differences (code, SQL, SpEL, steps and contract are identical).");
    }
    if (data.cleaned) {
      ui.text("Files hold the semantic logic view (decoded code/SQL/SpEL, no env-local ids). Pass --raw for the full parsed method.");
    }
  },
};

// ─── history mode ──────────────────────────────────────────────────────────

async function executeHistoryDiff(
  args: DiffArgs & { uuid: string },
  context: { outputMode: "human" | "llm"; warn(msg: string): void },
): Promise<CommandResult<DiffData>> {
  const current = await adApi.fetchMethod(args.uuid, "v1");
  const category = current.category?.name ?? "";
  const methodName = current.name;

  let { from, to } = args;
  if (from == null || to == null) {
    if (context.outputMode === "llm") {
      throw new CliError(
        "--from and --to are required in --llm mode.",
        { code: "MISSING_VERSION" },
      );
    }
    const versions = await adApi.historyListAll(args.uuid, { includeDraft: true });
    if (versions.length === 0) {
      throw new CliError(`No version history found for ${methodName}.`, {
        code: "NO_VERSIONS",
      });
    }
    const sorted = [...versions].sort((a, b) => b.methodVersion - a.methodVersion);
    if (from == null) from = await pickVersionInteractive(sorted, "FROM version");
    if (to == null) to = await pickVersionInteractive(sorted, "TO version");
    if (from == null || to == null) {
      throw new CliError("Version selection cancelled.", { code: "VERSION_CANCELLED" });
    }
  }

  if (from === to) {
    context.warn(`Both sides resolve to v${from} — the diff will be empty.`);
  }

  // F7: read the versions from the chain the uuid names (draft vs published).
  const [leftFull, rightFull] = await Promise.all([
    getVersionOf(current, category, from),
    getVersionOf(current, category, to),
  ]);

  const leftParsed = parseVersionBody(leftFull);
  const rightParsed = parseVersionBody(rightFull);

  const dir = await mkdtemp(join(tmpdir(), "belz-ad-diff-"));
  const leftPath = join(dir, `${shortUuid(args.uuid)}-v${from}.json`);
  const rightPath = join(dir, `${shortUuid(args.uuid)}-v${to}.json`);

  const cmp = await writeSides(leftParsed, rightParsed, leftPath, rightPath, args.clean);
  const editor = await openEditor(args, context, leftPath, rightPath);

  return ok<DiffData>({
    mode: "history",
    uuid: args.uuid,
    left: { label: `v${from}`, path: leftPath },
    right: { label: `v${to}`, path: rightPath },
    editor,
    cleaned: args.clean,
    ...cmp,
  });
}

// ─── cross-env mode ────────────────────────────────────────────────────────
// AD-26: fetched IN-PROCESS (each env has its own session; Config.setActiveEnv
// switches, as `trace` does) and compared on the semantic view, so code / SQL
// / SpEL body changes show up and env-local ids / urls do not.

async function executeCrossEnvDiff(
  args: DiffArgs & { uuid: string },
  context: { outputMode: "human" | "llm"; warn(msg: string): void },
): Promise<CommandResult<DiffData>> {
  let { fromEnv, toEnv } = args;

  if (!fromEnv || !toEnv) {
    if (context.outputMode === "llm") {
      throw new CliError(
        "--from-env and --to-env are required in --llm mode.",
        { code: "MISSING_ENV" },
      );
    }
    if (!fromEnv) fromEnv = await pickEnvInteractive("FROM env");
    if (!toEnv) toEnv = await pickEnvInteractive("TO env");
    if (!fromEnv || !toEnv) {
      throw new CliError("Env selection cancelled.", { code: "ENV_CANCELLED" });
    }
  }

  const known = Object.keys(Config.getAllEnvs());
  for (const env of [fromEnv, toEnv]) {
    if (!known.includes(env)) {
      throw new CliError(`Unknown env '${env}'. Available: ${known.join(", ")}`, { code: "INVALID_ENV" });
    }
  }

  if (fromEnv === toEnv) {
    context.warn(`Both sides resolve to ${fromEnv} — the diff will be empty.`);
  }

  // Sequential: the active env is process-global.
  const left = await fetchOnEnv(args.uuid, fromEnv);
  const right = await fetchOnEnv(args.uuid, toEnv);

  const dir = await mkdtemp(join(tmpdir(), "belz-ad-diff-"));
  const leftPath = join(dir, `${shortUuid(args.uuid)}-${fromEnv}.json`);
  const rightPath = join(dir, `${shortUuid(args.uuid)}-${toEnv}.json`);

  const cmp = await writeSides(left, right, leftPath, rightPath, args.clean);
  const editor = await openEditor(args, context, leftPath, rightPath);

  return ok<DiffData>({
    mode: "cross-env",
    uuid: args.uuid,
    left: { label: fromEnv, path: leftPath },
    right: { label: toEnv, path: rightPath },
    editor,
    cleaned: args.clean,
    ...cmp,
  });
}

/** Fetch + parse the method on `env` in-process, restoring the active env afterwards. */
export async function fetchOnEnv(uuid: string, env: string): Promise<HydratedMethod> {
  const original = Config.activeEnv.name;
  try {
    Config.setActiveEnv(env);
    return await adApi.fetchMethod(uuid, "v1");
  } catch (e) {
    if (e instanceof CliError) {
      throw new CliError(`${env}: ${e.message}`, { code: e.code, details: { env, ...(e.details as object) } });
    }
    throw e;
  } finally {
    Config.setActiveEnv(original);
  }
}

/** Write both sides (semantic view, or the full parsed method with --raw) and compare the semantic views. */
async function writeSides(
  left: HydratedMethod,
  right: HydratedMethod,
  leftPath: string,
  rightPath: string,
  clean: boolean,
): Promise<{ changed: boolean; differences: string[] }> {
  const lv = methodDiffView(left);
  const rv = methodDiffView(right);
  await Promise.all([
    writeFile(leftPath, JSON.stringify(clean ? lv : left, null, 2)),
    writeFile(rightPath, JSON.stringify(clean ? rv : right, null, 2)),
  ]);
  const differences = diffPaths(lv, rv);
  return { changed: differences.length > 0, differences };
}

// ─── interactive pickers ───────────────────────────────────────────────────

async function pickMethodInteractive(
  context: { warn(msg: string): void },
): Promise<string | undefined> {
  const { index, source } = await loadOrBuildMethodFinderIndex({ refresh: false });
  if (source === "cache") {
    context.warn("Using cached method index. Run `belz ad find --refresh` to rebuild.");
  }
  if (index.methods.length === 0) {
    throw new CliError("Method index is empty.", { code: "NO_METHODS" });
  }

  const sorted: MethodFinderMethod[] = [...index.methods].sort((a, b) =>
    a.methodName.localeCompare(b.methodName) || a.uuid.localeCompare(b.uuid),
  );
  const rows = sorted.map((m) =>
    [
      m.methodName,
      m.aliasName || "-",
      m.state,
      m.categoryName,
      m.uuid,
    ].join("\t"),
  );

  const line = await runFzf(rows, { prompt: "Method> ", withNth: "1,2,3,4" });
  if (!line) return undefined;
  const parts = line.split("\t");
  return parts[4]?.trim() || undefined;
}

async function pickVersionInteractive(
  versions: MethodVersionSummary[],
  promptLabel: string,
): Promise<number | undefined> {
  const rows = versions.map((v) =>
    [
      `v${v.methodVersion}`,
      v.addedWhen || "?",
      v.isPublished ? "PUBLISHED" : "draft",
      `by ${v.addedBy}`,
      v.methodVersionID,
    ].join("\t"),
  );
  const line = await runFzf(rows, { prompt: `${promptLabel}> `, withNth: "1,2,3,4" });
  if (!line) return undefined;
  const parts = line.split("\t");
  const versionToken = parts[0]?.trim().replace(/^v/, "");
  const num = versionToken ? parseInt(versionToken, 10) : NaN;
  return Number.isFinite(num) ? num : undefined;
}

async function pickEnvInteractive(promptLabel: string): Promise<string | undefined> {
  // The active env's project family (sems-* / nsm-* …), from the config.
  const line = await runFzf(traceEnvFamily(Config.activeEnv.name), { prompt: `${promptLabel}> ` });
  return line || undefined;
}

interface FzfOpts {
  prompt: string;
  withNth?: string;
}

function runFzf(rows: string[], opts: FzfOpts): Promise<string | undefined> {
  if (rows.length === 0) return Promise.resolve(undefined);

  const fzfArgs = [
    "--delimiter",
    "\t",
    "--prompt",
    opts.prompt,
    "--height",
    "85%",
    "--layout",
    "reverse",
    "--border",
    "--cycle",
  ];
  if (opts.withNth) fzfArgs.push("--with-nth", opts.withNth);

  return new Promise((resolve, reject) => {
    const child = nodeSpawn("fzf", fzfArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let missing = false;

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        missing = true;
      } else {
        reject(err);
      }
    });
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (code) => {
      if (missing) {
        reject(
          new CliError(
            "fzf is not installed. Install fzf, or pass UUID/--from/--to/--from-env/--to-env explicitly.",
            { code: "FZF_NOT_INSTALLED" },
          ),
        );
        return;
      }
      if (code === 130 || code === 1) {
        resolve(undefined);
        return;
      }
      if (code !== 0) {
        reject(
          new CliError(`fzf failed${stderr ? `: ${stderr.trim()}` : "."}`, {
            code: "FZF_FAILED",
          }),
        );
        return;
      }
      resolve(stdout.trim() || undefined);
    });
    child.stdin.write(rows.join("\n"));
    child.stdin.end();
  });
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Launch the diff editor (ADR-R7): never by default in --llm mode (an agent
 * run must not pop a window on the developer's desktop), and a missing
 * binary is a warning plus `editor: null`, not a crash or a false "Opened".
 */
async function openEditor(
  args: Pick<DiffArgs, "editor" | "noEditor">,
  context: { outputMode: "human" | "llm"; warn(msg: string): void },
  left: string,
  right: string,
): Promise<string | null> {
  if (args.noEditor) return null;
  const editor = args.editor ?? (context.outputMode === "llm" ? null : "zed");
  if (!editor) return null;
  const error = await spawnEditor(editor, left, right);
  if (error) {
    context.warn(`Could not start editor '${editor}' (${error}); both sides are on disk.`);
    return null;
  }
  return editor;
}

/** Resolves null once the editor process started, else the error message. */
export function spawnEditor(editor: string, left: string, right: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = nodeSpawn(editor, ["--diff", left, right], { detached: true, stdio: "ignore" });
      child.once("error", (e) => resolve(e.message));
      child.once("spawn", () => {
        child.unref();
        resolve(null);
      });
    } catch (e) {
      resolve((e as Error).message);
    }
  });
}

function shortUuid(uuid: string): string {
  return uuid.slice(0, 8);
}

export default command;
