import Table from "cli-table3";
import chalk from "chalk";
import type { CommandEnvelope, HumanPresenterHelpers } from "./command";

class HumanUi implements HumanPresenterHelpers {
  section(title: string) {
    console.log(chalk.bold.underline(`\n${title}`));
  }

  text(message: string) {
    console.log(message);
  }

  success(message: string) {
    console.log(chalk.green(`✅ ${message}`));
  }

  info(message: string) {
    console.log(chalk.blue(`[Info] ${message}`));
  }

  warn(message: string) {
    console.log(chalk.yellow(`⚠ ${message}`));
  }

  error(message: string) {
    console.error(chalk.red(`❌ ${message}`));
  }

  kv(key: string, value: unknown) {
    console.log(`${chalk.bold(key)}: ${stringifyScalar(value)}`);
  }

  table(headers: string[], rows: unknown[][]) {
    const table = new Table({
      head: headers,
      wordWrap: true,
    });
    table.push(...rows);
    console.log(table.toString());
  }

  object(value: unknown) {
    console.dir(value, { depth: null, colors: true });
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
  return Array.isArray(value) && value.every(item => isPlainObject(item));
}

function renderDefaultHuman(envelope: CommandEnvelope<unknown>, ui: HumanPresenterHelpers) {
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
    const headers = Array.from(
      new Set(data.flatMap(row => Object.keys(row)))
    );
    const rows = data.map(row => headers.map(header => row[header] ?? ""));
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
) {
  const ui = new HumanUi();
  if (presenter) {
    presenter(envelope, ui);
    return;
  }
  renderDefaultHuman(envelope, ui);
}

export function renderLLM(envelope: CommandEnvelope<unknown>) {
  console.log(JSON.stringify(envelope));
}
