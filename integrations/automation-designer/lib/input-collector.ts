import { readFile } from "fs/promises";
import { prompts, getOutputMode, CliError } from "@belzabar/core";
import type { MethodField } from "./types/common";

/**
 * Collect test-input values for a method. Works off the unified MethodField
 * shape (both V1 and V2 parsers produce this). `field.code` is the identifier;
 * `field.type` drives the prompt widget.
 */
/** `--input <fieldCode>=<value>` → [fieldCode, raw value]. */
export function splitInputPair(s: string): [string, string] {
  const i = s.indexOf("=");
  if (i <= 0) throw new CliError(`Invalid --input '${s}': use --input <fieldCode>=<value>.`, { code: "INVALID_INPUT" });
  return [s.slice(0, i).trim(), s.slice(i + 1)];
}

/**
 * String inputs keep the typed text; other types parse as JSON when they can
 * (`--input count=5` → 5, `--input zip=02134` stays "02134").
 */
export function coerceInputValue(raw: string, type: string | undefined): unknown {
  const t = (type ?? "").toUpperCase();
  if (t === "STRING" || t === "TEXT" || t === "") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * `--inputs <file|json>` (same convention as `ad run`'s payload): an existing
 * file is read, otherwise the argument must be an inline JSON object.
 */
async function readInputsArg(arg: string): Promise<Record<string, unknown>> {
  // Stable codes (not UNHANDLED_EXCEPTION): FILE_NOT_FOUND, INVALID_JSON, INVALID_INPUTS.
  const inline = arg.trimStart().startsWith("{");
  let content: string;
  if (inline) content = arg;
  else {
    try {
      content = await readFile(arg, "utf-8");
    } catch (error) {
      throw new CliError(`Cannot read inputs file ${arg}: ${(error as Error).message} (--inputs takes a file or an inline JSON object).`, {
        code: "FILE_NOT_FOUND",
        details: { path: arg },
      });
    }
  }
  const what = inline ? "--inputs JSON" : `Inputs file ${arg}`;
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new CliError(`${what} is not valid JSON: ${(error as Error).message}`, { code: "INVALID_JSON", details: inline ? {} : { path: arg } });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CliError(`${what} must hold a JSON object {inputKey: value}.`, { code: "INVALID_INPUTS", details: inline ? {} : { path: arg } });
  }
  return data as Record<string, unknown>;
}

/**
 * Apply `--input k=v` pairs (typed by the method's input types) on top of `values`, keep only
 * the method's inputs, and fail MISSING_INPUT when a required one is absent (`from` names the
 * source in the message).
 */
export function resolveInputValues(
  inputs: MethodField[],
  given: Record<string, unknown>,
  pairs: readonly string[],
  from: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  const values = { ...given };
  const known = new Map(inputs.map((i) => [i.code, i]));
  for (const p of pairs) {
    const [k, v] = splitInputPair(p);
    if (!known.has(k)) {
      throw new CliError(`--input ${k}: the method has no input '${k}'. Inputs: ${[...known.keys()].join(", ") || "(none)"}.`, {
        code: "INVALID_INPUT",
        details: { key: k, inputs: [...known.keys()] },
      });
    }
    values[k] = coerceInputValue(v, String(known.get(k)!.type ?? ""));
  }
  const collected: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const input of inputs) {
    if (values[input.code] !== undefined) collected[input.code] = values[input.code];
    else if (input.required) missing.push(input.code);
  }
  if (missing.length > 0) {
    throw new CliError(`${from} is missing required input(s): ${missing.join(", ")}.`, {
      code: "MISSING_INPUT",
      details: { ...details, missing },
    });
  }
  return collected;
}

export class InputCollector {
  /**
   * `source`: `--inputs <file|json>`; `pairs`: repeatable `--input k=v`, applied
   * on top (typed by the method's input types). With neither, prompts (human
   * mode only).
   */
  static async collect(
    inputs: MethodField[],
    source?: string,
    pairs: readonly string[] = [],
  ): Promise<Record<string, unknown>> {
    const collected: Record<string, unknown> = {};

    if (source || pairs.length > 0) {
      const values: Record<string, unknown> = source ? await readInputsArg(source) : {};
      const from = source ? (source.trimStart().startsWith("{") ? "--inputs" : `Inputs file ${source}`) : "--input";
      return resolveInputValues(inputs, values, pairs, from, source ? { path: source } : {});
    }

    if (getOutputMode() === "llm") {
      throw new CliError(
        "Interactive input collection is not supported with --llm. Provide --input <key>=<value> (repeatable) or --inputs <file|json>.",
        { code: "INTERACTIVE_NOT_SUPPORTED" },
      );
    }

    for (const input of inputs) {
      const label = input.displayName && input.displayName !== input.code
        ? `${input.displayName} (${input.code})`
        : input.code;
      const message = `${label} [${input.type}]${input.required ? " *" : ""}`;

      if (input.type === "BOOLEAN") {
        collected[input.code] = await prompts.confirm({
          message,
          initialValue: false,
        });
        continue;
      }

      const raw = await prompts.text({
        message,
        validate: (val: string) => {
          if (input.required && !val) return "This field is required.";
          if (input.type === "JSON" && val) {
            try {
              JSON.parse(val);
            } catch {
              return "Invalid JSON string.";
            }
          }
          return undefined;
        },
      });

      if (raw) {
        collected[input.code] = input.type === "JSON" ? JSON.parse(raw) : raw;
      } else {
        collected[input.code] = null;
      }
    }

    return collected;
  }
}
