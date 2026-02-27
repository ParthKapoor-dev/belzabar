import { join } from "path";
import { mkdir } from "fs/promises";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import { fetchAutomationDefinition } from "./api";
import type { AutomationDefinition, AutomationUserInput } from "./types";

const CACHE_DIR = join(BELZ_CONFIG_DIR, "cache", "definitions");

export class ServiceHydrator {
  static async ensureDir() {
    await mkdir(CACHE_DIR, { recursive: true });
  }

  static async getDefinition(automationId: string): Promise<AutomationDefinition | null> {
    await this.ensureDir();
    const filePath = join(CACHE_DIR, `${automationId}.json`);
    const file = Bun.file(filePath);

    if (await file.exists()) {
      try {
        return await file.json() as AutomationDefinition;
      } catch (e) {
        // ignore cache parse errors and fallback to network fetch
      }
    }

    // Fetch if missing
    try {
      const response = await fetchAutomationDefinition(automationId);
      
      if (!response.ok) {
        return null;
      }

      const data = await response.json() as AutomationDefinition;
      await Bun.write(filePath, JSON.stringify(data, null, 2));
      return data;
    } catch (e) {
      return null;
    }
  }

  static async ensureCached(automationId: string): Promise<void> {
    await this.getDefinition(automationId);
  }

  static findInputLabel(def: AutomationDefinition, inputId: string): { label: string; encoding?: string } | null {
    if (!def.automationAPI.automationUserInputs) return null;

    const findRecursive = (inputs: AutomationUserInput[]): { label: string; encoding?: string } | null => {
      for (const input of inputs) {
        if (input.id === inputId) {
          return { label: input.label, encoding: input.encodingType };
        }
        if (input.automationUserInputs) {
          const found = findRecursive(input.automationUserInputs);
          if (found) return found;
        }
      }
      return null;
    };

    return findRecursive(def.automationAPI.automationUserInputs);
  }

  static flattenInputs(def: AutomationDefinition): { id: string; label: string; required: boolean; encoding?: string; orderIndex: number; depth: number; hidden: boolean }[] {
    const flattened: { id: string; label: string; required: boolean; encoding?: string; orderIndex: number; depth: number; hidden: boolean }[] = [];

    if (!def.automationAPI.automationUserInputs) return flattened;

    const traverse = (inputs: AutomationUserInput[], depth = 0) => {
      for (const input of inputs) {
        // Visual Depth Logic:
        // If label is empty, this container is "transparent" - children stay at current depth.
        // If label is present, this is a distinct level - children go deeper.
        const hasLabel = input.label && input.label.trim().length > 0;
        const nextDepth = hasLabel ? depth + 1 : depth;

        flattened.push({
          id: input.id,
          label: input.label,
          required: input.optional === false,
          encoding: input.encodingType,
          orderIndex: input.orderIndex || 0,
          depth: depth,
          hidden: input.showOnSDUi === false // Explicit check for false
        });

        if (input.automationUserInputs) {
          traverse(input.automationUserInputs, nextDepth);
        }
      }
    };

    traverse(def.automationAPI.automationUserInputs);
    // Sort by orderIndex
    return flattened.sort((a, b) => a.orderIndex - b.orderIndex);
  }
}
