import { readFile } from "fs/promises";
import inquirer from "inquirer";
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

    // 1. File Mode
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

    // 2. Interactive Mode
    console.log("Please provide values for the method inputs:");

    for (const input of inputs) {
      const label = input.displayName && input.displayName !== input.code
        ? `${input.displayName} (${input.code})`
        : input.code;
      const message = `${label} [${input.type}]${input.required ? " *" : ""}:`;

      if (input.type === "BOOLEAN") {
        const { value } = await inquirer.prompt([
          {
            type: "confirm",
            name: "value",
            message,
            default: false,
          },
        ]);
        collected[input.code] = value;
      } else {
        const { value } = await inquirer.prompt([
          {
            type: "input",
            name: "value",
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
              return true;
            },
          },
        ]);

        if (value) {
          collected[input.code] = input.type === "JSON" ? JSON.parse(value) : value;
        } else {
          collected[input.code] = null;
        }
      }
    }

    return collected;
  }
}
