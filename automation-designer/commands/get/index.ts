import { CliError, ok, type CommandModule } from "@belzabar/core";
import { apiFetch } from "../../lib/api";
import { parseMethodResponse } from "../../lib/parser";
import { CacheManager } from "../../lib/cache";
import { ServiceHydrator } from "../../lib/hydrator";
import type { RawMethodResponse, HydratedMethod } from "../../lib/types";

interface FetchMethodArgs {
  uuid: string;
  raw: boolean;
}

interface FetchMethodData {
  method: {
    uuid: string;
    referenceId: string;
    aliasName: string;
    methodName: string;
    category: string;
    state: string;
    version: number;
    inputCount: number;
    serviceCount: number;
  };
  hydratedServiceIds: string[];
  raw?: {
    method: HydratedMethod;
  };
}

const command: CommandModule<FetchMethodArgs, FetchMethodData> = {
  schema: "ad.get",
  parseArgs(args) {
    const uuid = args[0];
    if (!uuid || uuid.startsWith("-")) {
      throw new CliError("Missing UUID argument.", { code: "MISSING_UUID" });
    }
    return {
      uuid,
      raw: args.includes("--raw"),
    };
  },
  async execute({ uuid, raw }, context) {
    const path = `/rest/api/automation/chain/${uuid}`;
    const response = await apiFetch(path, {
      method: "GET",
      authMode: "Bearer",
    });

    if (response.status === 404) {
      throw new CliError("404 Chain Not Found", { code: "METHOD_NOT_FOUND" });
    }
    if (!response.ok) {
      throw new CliError(`Request failed ${response.status} ${response.statusText}`, {
        code: "FETCH_FAILED",
      });
    }

    const rawData = (await response.json()) as RawMethodResponse;
    const method = parseMethodResponse(rawData);
    await CacheManager.save(uuid, method);

    const hydratedServiceIds: string[] = [];
    if (method.services.length > 0) {
      const uniqueIds = new Set(method.services.map(s => s.automationId));
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
        methodName: method.methodName,
        category: method.category,
        state: method.state,
        version: method.version,
        inputCount: method.inputs.length,
        serviceCount: method.services.length,
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
    ui.success(`Fetched and cached method: ${data.method.aliasName}`);
    ui.table(
      ["Property", "Value"],
      [
        ["Method Name", data.method.methodName],
        ["Alias", data.method.aliasName],
        ["UUID", data.method.uuid],
        ["State", data.method.state],
        ["Version", data.method.version],
        ["Inputs", data.method.inputCount],
        ["Services", data.method.serviceCount],
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
