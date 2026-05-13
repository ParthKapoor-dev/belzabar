import { CliError, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import { parseAdCommonArgs, emitFallbackWarning } from "../../lib/args/common";
import type { HydratedMethod } from "../../lib/types/common";

interface FetchMethodArgs {
  uuid: string;
  raw: boolean;
  apiVersion: "v1" | "v2";
}

interface FetchMethodData {
  method: {
    uuid: string;
    referenceId: string | null;
    aliasName?: string;
    methodName: string;
    category: string;
    state: string;
    version: number;
    inputCount: number;
    serviceCount: number;
    sourceVersion: "v1" | "v2";
  };
  hydratedServiceIds: string[];
  raw?: {
    method: HydratedMethod;
  };
}

function resolveUuid(input: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last || !/^[0-9a-f]{32}$/i.test(last)) {
      throw new CliError("Could not extract a valid UUID from the given URL.", {
        code: "INVALID_URL",
      });
    }
    return last;
  }
  return input;
}

const command: CommandModule<FetchMethodArgs, FetchMethodData> = {
  schema: "ad.fetch",
  parseArgs(args) {
    const { common, rest } = parseAdCommonArgs(args, "fetch", "fetch");
    emitFallbackWarning(common, "fetch");
    const first = rest[0];
    if (!first || first.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }
    const uuid = resolveUuid(first);
    return {
      uuid,
      raw: rest.includes("--raw"),
      apiVersion: common.apiVersion.version,
    };
  },
  async execute({ uuid, raw, apiVersion }, context) {
    const method = await adApi.fetchMethod(uuid, apiVersion);
    await CacheManager.save(uuid, method);

    const hydratedServiceIds: string[] = [];
    // V1-only hydration: the service catalog lookups are keyed on numeric IDs.
    if (method.sourceVersion === "v1" && method.parsedSteps.length > 0) {
      const uniqueIds = new Set<string>();
      for (const step of method.parsedSteps) {
        if (step.automationId) uniqueIds.add(step.automationId);
      }
      for (const serviceId of uniqueIds) {
        await ServiceHydrator.ensureCached(serviceId);
        hydratedServiceIds.push(serviceId);
      }
    }

    if (hydratedServiceIds.length === 0) {
      context.warn("No service definitions needed hydration.");
    }

    const data: FetchMethodData = {
      method: {
        uuid: method.uuid,
        referenceId: method.referenceId,
        aliasName: method.aliasName,
        methodName: method.name,
        category: method.category?.name ?? "Uncategorized",
        state: method.state,
        version: method.version,
        inputCount: method.inputs.length,
        serviceCount: method.parsedSteps.length,
        sourceVersion: method.sourceVersion,
      },
      hydratedServiceIds,
    };

    if (raw) {
      data.raw = { method };
    }

    return ok(data);
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as FetchMethodData;
    ui.success(`Fetched and cached method: ${data.method.methodName}`);
    ui.table(
      ["Property", "Value"],
      [
        ["Method Name", data.method.methodName],
        ["Alias", data.method.aliasName ?? ""],
        ["UUID", data.method.uuid],
        ["State", data.method.state],
        ["Version", data.method.version],
        ["Source", data.method.sourceVersion.toUpperCase()],
        ["Inputs", data.method.inputCount],
        ["Steps", data.method.serviceCount],
        ["Hydrated Service Definitions", data.hydratedServiceIds.length],
      ]
    );

    if (data.raw) {
      ui.section("Raw Data");
      ui.object(data.raw);
    }
  },
};

export default command;
