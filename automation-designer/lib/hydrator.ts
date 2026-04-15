import { join } from "path";
import { Cache, BELZ_CONFIG_DIR } from "@belzabar/core";
import * as v1 from "./api/v1";
import type { V1AutomationDefinition, V1AutomationUserInput } from "./types/v1-wire";

const definitionCache = new Cache<V1AutomationDefinition>({
  dir: join(BELZ_CONFIG_DIR, "cache", "definitions"),
  // hyphenated IDs (core-maintained) → permanent; non-hyphenated → 1 hour
  ttlMs: (key: string) => (key.includes("-") ? null : 60 * 60 * 1000),
});

export class ServiceHydrator {
  static async getDefinition(automationId: string): Promise<V1AutomationDefinition | null> {
    const cached = await definitionCache.load(automationId);
    if (cached) return cached;

    try {
      const data = await v1.fetchAutomationDefinition(automationId);
      if (!data) return null;
      await definitionCache.save(automationId, data);
      return data;
    } catch {
      return null;
    }
  }

  static async ensureCached(automationId: string): Promise<void> {
    await this.getDefinition(automationId);
  }

  static findInputLabel(
    def: V1AutomationDefinition,
    inputId: string,
  ): { label: string; encoding?: string } | null {
    if (!def.automationAPI.automationUserInputs) return null;

    const findRecursive = (
      inputs: V1AutomationUserInput[],
    ): { label: string; encoding?: string } | null => {
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

  static flattenInputs(def: V1AutomationDefinition): {
    id: string;
    label: string;
    required: boolean;
    encoding?: string;
    orderIndex: number;
    depth: number;
    hidden: boolean;
  }[] {
    const flattened: {
      id: string;
      label: string;
      required: boolean;
      encoding?: string;
      orderIndex: number;
      depth: number;
      hidden: boolean;
    }[] = [];

    if (!def.automationAPI.automationUserInputs) return flattened;

    const traverse = (inputs: V1AutomationUserInput[], depth = 0) => {
      for (const input of inputs) {
        const hasLabel = input.label && input.label.trim().length > 0;
        const nextDepth = hasLabel ? depth + 1 : depth;

        flattened.push({
          id: input.id,
          label: input.label,
          required: input.optional === false,
          encoding: input.encodingType,
          orderIndex: input.orderIndex || 0,
          depth: depth,
          hidden: input.showOnSDUi === false,
        });

        if (input.automationUserInputs) {
          traverse(input.automationUserInputs, nextDepth);
        }
      }
    };

    traverse(def.automationAPI.automationUserInputs);
    return flattened.sort((a, b) => a.orderIndex - b.orderIndex);
  }
}
