import { CliError, ok, type CommandModule } from "@belzabar/core";
import { spawn as nodeSpawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adApi,
  type MethodVersionSummary,
} from "../../lib/api/index";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import { parseVersionBody } from "../../lib/fingerprint";
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
  editor: string;
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
  editor: string;
  cleaned: boolean;
}

const KNOWN_ENVS = ["nsm-dev", "nsm-qa", "nsm-uat"];

const NOISE_KEYS = new Set([
  "fetchedAt",
  "savedAt",
  "parseWarnings",
  "modifiedOn",
  "createdOn",
  "raw",
]);

const command: CommandModule<DiffArgs, DiffData> = {
  schema: "ad.diff",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "fetch", "diff");
    emitFallbackWarning(common, "diff");

    let mode: Mode = "history";
    let uuid: string | undefined;
    let from: number | undefined;
    let to: number | undefined;
    let fromEnv: string | undefined;
    let toEnv: string | undefined;
    let clean = true;
    let editor = "zed";

    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i] ?? "";

      if (t === "--cross-env") {
        mode = "cross-env";
        continue;
      }
      if (t === "--from") {
        from = parseIntFlag(rest[i + 1], "--from");
        i += 1;
        continue;
      }
      if (t === "--to") {
        to = parseIntFlag(rest[i + 1], "--to");
        i += 1;
        continue;
      }
      if (t === "--from-env") {
        fromEnv = rest[i + 1];
        if (!fromEnv) {
          throw new CliError("--from-env requires a value.", { code: "MISSING_FROM_ENV" });
        }
        i += 1;
        continue;
      }
      if (t === "--to-env") {
        toEnv = rest[i + 1];
        if (!toEnv) {
          throw new CliError("--to-env requires a value.", { code: "MISSING_TO_ENV" });
        }
        i += 1;
        continue;
      }
      if (t === "--clean") {
        clean = true;
        continue;
      }
      if (t === "--raw") {
        clean = false;
        continue;
      }
      if (t === "--editor") {
        const next = rest[i + 1];
        if (!next) {
          throw new CliError("--editor requires a value.", { code: "MISSING_EDITOR" });
        }
        editor = next;
        i += 1;
        continue;
      }
      if (t.startsWith("-")) {
        throw new CliError(`Unknown flag: ${t}`, { code: "UNKNOWN_FLAG" });
      }
      if (uuid !== undefined) {
        throw new CliError(`Unexpected positional argument: ${t}`, { code: "UNEXPECTED_ARG" });
      }
      uuid = t;
    }

    if (fromEnv || toEnv) mode = "cross-env";

    return { mode, uuid, from, to, fromEnv, toEnv, clean, editor };
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

    const uuid = args.uuid ?? (await pickMethodInteractive(context));
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
    ui.success(`Opened ${data.editor} --diff for ${data.uuid.slice(0, 8)}…`);
    ui.table(
      ["Side", "Label", "File"],
      [
        ["left", data.left.label, data.left.path],
        ["right", data.right.label, data.right.path],
      ],
    );
    if (data.cleaned) {
      ui.text(
        "Stripped noisy fields (fetchedAt, savedAt, parseWarnings, createdOn, modifiedOn, raw). Pass --raw to keep them.",
      );
    }
  },
};

// ─── history mode ──────────────────────────────────────────────────────────

async function executeHistoryDiff(
  args: DiffArgs & { uuid: string },
  context: { outputMode: "human" | "llm"; warn(msg: string): void },
): Promise<{ ok: true; data: DiffData; meta?: Record<string, unknown> }> {
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

  const [leftFull, rightFull] = await Promise.all([
    adApi.historyGet({ category, methodName, version: from, includeDraft: true }),
    adApi.historyGet({ category, methodName, version: to, includeDraft: true }),
  ]);

  const leftParsed = parseVersionBody(leftFull);
  const rightParsed = parseVersionBody(rightFull);

  const dir = await mkdtemp(join(tmpdir(), "belz-ad-diff-"));
  const leftPath = join(dir, `${shortUuid(args.uuid)}-v${from}.json`);
  const rightPath = join(dir, `${shortUuid(args.uuid)}-v${to}.json`);

  await Promise.all([
    writeFile(leftPath, serialize(leftParsed, args.clean)),
    writeFile(rightPath, serialize(rightParsed, args.clean)),
  ]);

  spawnEditor(args.editor, leftPath, rightPath);

  return ok<DiffData>({
    mode: "history",
    uuid: args.uuid,
    left: { label: `v${from}`, path: leftPath },
    right: { label: `v${to}`, path: rightPath },
    editor: args.editor,
    cleaned: args.clean,
  });
}

// ─── cross-env mode ────────────────────────────────────────────────────────
// Each env has its own auth session, so we shell out to `belz ad show --env X --llm`
// once per side. That reuses the existing per-env auth + cache plumbing without
// re-initialising the in-process API client.

async function executeCrossEnvDiff(
  args: DiffArgs & { uuid: string },
  context: { outputMode: "human" | "llm"; warn(msg: string): void },
): Promise<{ ok: true; data: DiffData; meta?: Record<string, unknown> }> {
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

  if (fromEnv === toEnv) {
    context.warn(`Both sides resolve to ${fromEnv} — the diff will be empty.`);
  }

  const [leftJson, rightJson] = await Promise.all([
    fetchMethodViaCli(args.uuid, fromEnv),
    fetchMethodViaCli(args.uuid, toEnv),
  ]);

  const dir = await mkdtemp(join(tmpdir(), "belz-ad-diff-"));
  const leftPath = join(dir, `${shortUuid(args.uuid)}-${fromEnv}.json`);
  const rightPath = join(dir, `${shortUuid(args.uuid)}-${toEnv}.json`);

  await Promise.all([
    writeFile(leftPath, serialize(leftJson, args.clean)),
    writeFile(rightPath, serialize(rightJson, args.clean)),
  ]);

  spawnEditor(args.editor, leftPath, rightPath);

  return ok<DiffData>({
    mode: "cross-env",
    uuid: args.uuid,
    left: { label: fromEnv, path: leftPath },
    right: { label: toEnv, path: rightPath },
    editor: args.editor,
    cleaned: args.clean,
  });
}

function fetchMethodViaCli(uuid: string, env: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("belz", ["ad", "show", uuid, "--env", env, "--llm"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
          new CliError("'belz' binary not found on PATH for cross-env fetch.", {
            code: "BELZ_NOT_ON_PATH",
          }),
        );
        return;
      }
      try {
        const envelope = JSON.parse(stdout) as {
          ok: boolean;
          data?: unknown;
          error?: { message?: string };
        };
        if (!envelope.ok) {
          reject(
            new CliError(
              `belz ad show failed for env ${env}: ${envelope.error?.message ?? "unknown error"}`,
              { code: "CROSS_ENV_FETCH_FAILED" },
            ),
          );
          return;
        }
        resolve(envelope.data);
      } catch {
        const tail = (stderr || stdout).trim().slice(-200);
        reject(
          new CliError(
            `Failed to parse 'belz ad show --llm' output for env ${env} (exit ${code}).${tail ? ` Tail: ${tail}` : ""}`,
            { code: "CROSS_ENV_PARSE_FAILED" },
          ),
        );
      }
    });
  });
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
  const line = await runFzf(KNOWN_ENVS, { prompt: `${promptLabel}> ` });
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

function spawnEditor(editor: string, left: string, right: string): void {
  const child = nodeSpawn(editor, ["--diff", left, right], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function serialize(value: unknown, clean: boolean): string {
  return JSON.stringify(clean ? stripNoise(value) : value, null, 2);
}

function stripNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNoise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !NOISE_KEYS.has(k))
        .map(([k, v]) => [k, stripNoise(v)]),
    );
  }
  return value;
}

function shortUuid(uuid: string): string {
  return uuid.slice(0, 8);
}

function parseIntFlag(value: string | undefined, flag: string): number {
  if (!value) {
    throw new CliError(`${flag} requires a numeric value.`, { code: "MISSING_VALUE" });
  }
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n <= 0) {
    throw new CliError(`${flag} must be a positive integer.`, { code: "INVALID_VALUE" });
  }
  return n;
}

export default command;
