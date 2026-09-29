import { readFile } from "fs/promises";
import { prompts, getOutputMode, CliError } from "@belzabar/core";
import type { MethodField } from "./types/common";

/**
 * Collect test-input values for a method. Works off the unified MethodField
 * shape (both V1 and V2 parsers produce this). `field.code` is the identifier;
 * `field.type` drives the prompt widget.
 */
export class InputCollector {
  static async collect(
    inputs: MethodField[],
    filePath?: string,
  ): Promise<Record<string, unknown>> {
    const collected: Record<string, unknown> = {};

    if (filePath) {
      // Stable codes (not UNHANDLED_EXCEPTION): FILE_NOT_FOUND, INVALID_JSON, INVALID_INPUTS, MISSING_INPUT.
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (error) {
        throw new CliError(`Cannot read inputs file ${filePath}: ${(error as Error).message}`, {
          code: "FILE_NOT_FOUND",
          details: { path: filePath },
        });
      }
      let fileData: unknown;
      try {
        fileData = JSON.parse(content);
      } catch (error) {
        throw new CliError(`Inputs file ${filePath} is not valid JSON: ${(error as Error).message}`, {
          code: "INVALID_JSON",
          details: { path: filePath },
        });
      }
      if (!fileData || typeof fileData !== "object" || Array.isArray(fileData)) {
        throw new CliError(`Inputs file ${filePath} must hold a JSON object {inputKey: value}.`, {
          code: "INVALID_INPUTS",
          details: { path: filePath },
        });
      }
      const values = fileData as Record<string, unknown>;
      const missing: string[] = [];
      for (const input of inputs) {
        if (values[input.code] !== undefined) collected[input.code] = values[input.code];
        else if (input.required) missing.push(input.code);
      }
      if (missing.length > 0) {
        throw new CliError(`Inputs file ${filePath} is missing required input(s): ${missing.join(", ")}.`, {
          code: "MISSING_INPUT",
          details: { path: filePath, missing },
        });
      }
      return collected;
    }

    if (getOutputMode() === "llm") {
      throw new CliError(
        "Interactive input collection is not supported with --llm. Provide --inputs <file> instead.",
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
