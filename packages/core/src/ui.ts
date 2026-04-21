import Table from "cli-table3";
import pc from "picocolors";
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

let currentOutputMode: OutputMode = "human";

export function setOutputMode(mode: OutputMode): void {
  currentOutputMode = mode;
}

export function getOutputMode(): OutputMode {
  return currentOutputMode;
}

class HumanUi implements HumanPresenterHelpers {
  section(title: string): void {
    console.log();
    console.log(pc.bold(pc.underline(title)));
  }

  text(message: string): void {
    log.message(message);
  }

  success(message: string): void {
    log.success(message);
  }

  info(message: string): void {
    log.info(message);
  }

  warn(message: string): void {
    log.warn(message);
  }

  error(message: string): void {
    log.error(message);
  }

  step(message: string): void {
    log.step(message);
  }

  note(title: string, body: string): void {
    clackNote(body, title);
  }

  kv(key: string, value: unknown): void {
    log.message(`${pc.bold(key)}: ${stringifyScalar(value)}`);
  }

  table(headers: string[], rows: unknown[][]): void {
    const t = new Table({
      head: headers.map((h) => pc.cyan(pc.bold(h))),
      style: { head: [], border: [] },
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
  if (value === null || value === undefined) return "null";
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
  if (!envelope.ok) {
    ui.error(envelope.error?.message ?? "Command failed.");
    if (envelope.error?.details !== undefined) {
      ui.section("Error Details");
      ui.object(envelope.error.details);
    }
    return;
  }

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

export function renderHuman(
  envelope: CommandEnvelope<unknown>,
  presenter?: (envelope: CommandEnvelope<unknown>, ui: HumanPresenterHelpers) => void
): void {
  const ui = new HumanUi();
  if (presenter) {
    presenter(envelope, ui);
    return;
  }
  renderDefaultHuman(envelope, ui);
}

export function renderLLM(envelope: CommandEnvelope<unknown>): void {
  console.log(JSON.stringify(envelope));
}

export const lifecycle = {
  intro(title: string): void {
    if (currentOutputMode === "llm") return;
    clackIntro(pc.bold(pc.cyan(title)));
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
    return assertAnswered(await clackText(opts));
  },
  async password(opts: {
    message: string;
    validate?: Validator;
  }): Promise<string> {
    guardInteractive("password input");
    return assertAnswered(await clackPassword(opts));
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

export { pc as colors };
