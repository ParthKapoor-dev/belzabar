import Table from "cli-table3";
import {
  log,
  note as clackNote,
  intro as clackIntro,
  outro as clackOutro,
  cancel as clackCancel,
  spinner,
  confirm as clackConfirm,
  text as clackText,
  password as clackPassword,
  select as clackSelect,
  multiselect as clackMultiselect,
  isCancel,
} from "@clack/prompts";
import {
  CliError,
  type CommandEnvelope,
  type HumanPresenterHelpers,
  type OutputMode,
} from "./command";
import { ui as theme, term, symbols, wordmark } from "./theme";
import { vlog } from "./verbose";

let currentOutputMode: OutputMode = "human";

export function setOutputMode(mode: OutputMode): void {
  currentOutputMode = mode;
}

export function getOutputMode(): OutputMode {
  return currentOutputMode;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Print a line on stderr. Colours are decided from stdout's TTY state
 * (@belzabar/design/terminal), so when stderr alone is redirected
 * (`2>log`) the escape codes are stripped — unless FORCE_COLOR asks for them.
 */
export function printErr(line: string): void {
  const force = process.env.FORCE_COLOR;
  const forced = force !== undefined && force !== "" && force !== "0" && force !== "false";
  console.error(!process.stderr.isTTY && !forced ? line.replace(ANSI, "") : line);
}

/** Borderless cli-table3 chars — clean data grid, 2-space column gaps. */
const BORDERLESS = {
  top: "", "top-mid": "", "top-left": "", "top-right": "",
  bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
  left: "", "left-mid": "", mid: "", "mid-mid": "", right: "", "right-mid": "",
  middle: "  ",
} as const;

class HumanUi implements HumanPresenterHelpers {
  section(title: string): void {
    console.log();
    console.log(theme.heading(title));
  }

  text(message: string): void {
    console.log(message);
  }

  success(message: string): void {
    console.log(theme.ok(message));
  }

  info(message: string): void {
    console.log(theme.info(message));
  }

  /** Warnings go to stderr (F31), so piped stdout carries only the result. */
  warn(message: string): void {
    printErr(theme.warn(message));
  }

  /** Errors go to stderr (F31). */
  error(message: string): void {
    printErr(theme.err(message));
  }

  step(message: string): void {
    console.log(theme.step(message));
  }

  note(title: string, body: string): void {
    clackNote(body, title);
  }

  kv(key: string, value: unknown): void {
    console.log(`${theme.key(key)}  ${stringifyScalar(value)}`);
  }

  table(headers: string[], rows: unknown[][]): void {
    const t = new Table({
      head: headers.map((h) => theme.heading(h)),
      chars: BORDERLESS,
      style: { head: [], border: [], "padding-left": 0, "padding-right": 2 },
      wordWrap: true,
    });
    t.push(...(rows as any[]));
    console.log(t.toString());
  }

  object(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
  }
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return term.faint("null");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => isPlainObject(item));
}

function renderDefaultHuman(envelope: CommandEnvelope<unknown>, ui: HumanPresenterHelpers): void {
  const data = envelope.data;
  if (data === null || data === undefined) {
    ui.success("Command completed.");
    return;
  }

  if (isObjectArray(data)) {
    if (data.length === 0) {
      ui.info("No data.");
      return;
    }
    const headers = Array.from(new Set(data.flatMap((row) => Object.keys(row))));
    const rows = data.map((row) => headers.map((header) => row[header] ?? ""));
    ui.table(headers, rows);
    return;
  }

  if (isPlainObject(data)) {
    const entries = Object.entries(data);
    if (entries.every(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))) {
      ui.table(
        ["Property", "Value"],
        entries.map(([key, value]) => [key, stringifyScalar(value)])
      );
      return;
    }
    ui.object(data);
    return;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      ui.info("No data.");
      return;
    }
    ui.object(data);
    return;
  }

  ui.text(stringifyScalar(data));
}

/** Human error block → stderr: the message, then details (a `{text}` detail prints as-is). */
function renderErrorHuman(envelope: CommandEnvelope<unknown>): void {
  const error = envelope.error;
  printErr(theme.err(error?.message || "Command failed."));
  const details = error?.details;
  if (details === undefined || details === null) return;
  const keys = typeof details === "object" ? Object.keys(details as object) : [];
  if (keys.length === 1 && keys[0] === "text") {
    console.error((details as { text: unknown }).text);
    return;
  }
  if (keys.length === 0) return;
  printErr(theme.faint("details:"));
  console.error(JSON.stringify(details, null, 2));
}

/** `meta.warnings` → stderr, after the result (CORE-6). */
function renderWarningsHuman(envelope: CommandEnvelope<unknown>): void {
  const warnings = envelope.meta?.warnings;
  if (!Array.isArray(warnings)) return;
  for (const w of warnings) printErr(theme.warn(String(w)));
}

/**
 * Human rendering. Success: the command's presenter (or the default table/object
 * view) on stdout. Failure: the presenter still runs when the envelope carries
 * `data` (a failure-shaped result, `failWithData`), then the error goes to
 * stderr. Warnings always follow on stderr.
 */
export function renderHuman(
  envelope: CommandEnvelope<unknown>,
  presenter?: (envelope: CommandEnvelope<unknown>, ui: HumanPresenterHelpers) => void
): void {
  const ui = new HumanUi();
  if (envelope.ok) {
    if (presenter) presenter(envelope, ui);
    else renderDefaultHuman(envelope, ui);
  } else {
    if (presenter && envelope.data !== null && envelope.data !== undefined) presenter(envelope, ui);
    renderErrorHuman(envelope);
  }
  renderWarningsHuman(envelope);
}

export function renderLLM(envelope: CommandEnvelope<unknown>): void {
  console.log(JSON.stringify(envelope));
}

export const lifecycle = {
  intro(title: string): void {
    if (currentOutputMode === "llm") return;
    console.log();
    console.log(wordmark);
    console.log();
    clackIntro(theme.bold(title));
  },
  outro(message: string): void {
    if (currentOutputMode === "llm") return;
    clackOutro(message);
  },
  cancel(message?: string): void {
    if (currentOutputMode === "llm") return;
    clackCancel(message);
  },
  note(title: string, body: string): void {
    if (currentOutputMode === "llm") return;
    clackNote(body, title);
  },
  step(message: string): void {
    if (currentOutputMode === "llm") return;
    log.step(message);
  },
  /**
   * A transient status line from library code that has no CommandContext
   * (e.g. "401 — refreshing session"). Human mode: one faint stderr line.
   * `--llm`: never printed (stdout/stderr stay clean) — only the verbose log.
   */
  notice(message: string): void {
    vlog(message);
    if (currentOutputMode === "llm") return;
    printErr(theme.faint(message));
  },
  spinner(initialLabel: string) {
    if (currentOutputMode === "llm") {
      return {
        start: (_msg?: string) => {},
        stop: (_msg?: string) => {},
        message: (_msg: string) => {},
        cancel: (_msg?: string) => {},
        error: (_msg?: string) => {},
        clear: () => {},
        get isCancelled() { return false; },
      };
    }
    if (!process.stdout.isTTY) {
      // Not a terminal (piped/redirected): no animation frames or cursor codes
      // in the output (F32). Final messages go to stderr as plain lines.
      const line = (msg?: string) => { if (msg) console.error(msg); };
      let cancelled = false;
      return {
        start: (_msg?: string) => {},
        stop: (msg?: string) => line(msg),
        message: (_msg: string) => {},
        cancel: (msg?: string) => { cancelled = true; line(msg); },
        error: (msg?: string) => line(msg),
        clear: () => {},
        get isCancelled() { return cancelled; },
      };
    }
    const s = spinner();
    return {
      start: (msg?: string) => s.start(msg ?? initialLabel),
      stop: (msg?: string) => s.stop(msg ?? initialLabel),
      message: (msg: string) => s.message(msg),
      cancel: (msg?: string) => s.cancel(msg),
      error: (msg?: string) => s.error(msg),
      clear: () => s.clear(),
      get isCancelled() { return s.isCancelled; },
    };
  },
};

function guardInteractive(kind: string): void {
  if (currentOutputMode === "llm") {
    throw new CliError(`Interactive ${kind} is not supported with --llm.`, {
      code: "INTERACTIVE_NOT_SUPPORTED",
    });
  }
  if (!process.stdin.isTTY) {
    throw new CliError(`Interactive ${kind} requires an interactive terminal (TTY).`, {
      code: "NO_TTY",
    });
  }
}

function assertAnswered<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new CliError("Aborted by user.", { code: "USER_ABORT", exitCode: 130 });
  }
  return value as T;
}

type Validator = (v: string) => string | Error | undefined;

/** clack hands validators `string | undefined`; ours take a string. */
function adaptValidator(v?: Validator): ((value: string | undefined) => string | Error | undefined) | undefined {
  return v ? (value) => v(value ?? "") : undefined;
}

export const prompts = {
  async confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean> {
    guardInteractive("confirmation");
    return assertAnswered(await clackConfirm(opts));
  },
  async text(opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    defaultValue?: string;
    validate?: Validator;
  }): Promise<string> {
    guardInteractive("text input");
    return assertAnswered(await clackText({ ...opts, validate: adaptValidator(opts.validate) }));
  },
  async password(opts: {
    message: string;
    validate?: Validator;
  }): Promise<string> {
    guardInteractive("password input");
    return assertAnswered(await clackPassword({ ...opts, validate: adaptValidator(opts.validate) }));
  },
  async select<T>(opts: {
    message: string;
    options: Array<{ label: string; value: T; hint?: string }>;
    initialValue?: T;
  }): Promise<T> {
    guardInteractive("selection");
    return assertAnswered(await clackSelect(opts as any));
  },
  async multiselect<T>(opts: {
    message: string;
    options: Array<{ label: string; value: T; hint?: string }>;
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[]> {
    guardInteractive("multi-selection");
    return assertAnswered(await clackMultiselect(opts as any));
  },
};

export { theme, term, symbols };
