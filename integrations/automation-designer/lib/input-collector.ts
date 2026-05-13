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
      try {
        const content = await readFile(filePath, "utf-8");
        const fileData = JSON.parse(content);

        for (const input of inputs) {
          if (fileData[input.code] !== undefined) {
            collected[input.code] = fileData[input.code];
          } else if (input.required) {
            throw new Error(`Missing required input '${input.code}' in input file.`);
          }
        }
        return collected;
      } catch (error: any) {
        throw new Error(`Failed to load inputs from file: ${error.message}`);
      }
    }

    if (getOutputMode() === "llm") {
      throw new CliError(
        "Interactive input collection is not supported with --llm. Provide --input-file instead.",
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
