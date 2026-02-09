import { readFile } from "fs/promises";
import inquirer from "inquirer";
import type { InputField } from "./types";

export class InputCollector {
  static async collect(inputs: InputField[], filePath?: string): Promise<Record<string, any>> {
    const collected: Record<string, any> = {};

    // 1. File Mode
    if (filePath) {
      try {
        const content = await readFile(filePath, "utf-8");
        const fileData = JSON.parse(content);

        for (const input of inputs) {
          if (fileData[input.fieldCode] !== undefined) {
            collected[input.fieldCode] = fileData[input.fieldCode];
          } else if (input.required) {
            throw new Error(`Missing required input '${input.fieldCode}' in input file.`);
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
      const message = `${input.fieldCode} (${input.type})${input.required ? " [Required]" : " [Optional]"}:`;

      if (input.type === "BOOLEAN") {
        const { value } = await inquirer.prompt([
          {
            type: "confirm",
            name: "value",
            message: message,
            default: false,
          },
        ]);
        collected[input.fieldCode] = value;
      } else {
        const { value } = await inquirer.prompt([
          {
            type: "input",
            name: "value",
            message: message,
            validate: (val) => {
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
            if (input.type === "JSON") {
                collected[input.fieldCode] = JSON.parse(value);
            } else {
                collected[input.fieldCode] = value;
            }
        } else {
            // Explicitly set null for optional skipped fields if needed, or undefined?
            // User prompt says "testValue" property. Usually null is better for API.
            collected[input.fieldCode] = null; 
        }
      }
    }

    return collected;
  }
}
