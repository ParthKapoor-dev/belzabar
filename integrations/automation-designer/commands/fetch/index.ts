import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { adApi } from "../../lib/api/index";
import { CacheManager } from "../../lib/cache";
import { fetchMethodChecked } from "../../lib/view-fetch";
import { resolveMethodRef } from "@belzabar/core/platform";
import { AD_V2_FLAG, apiVersionOf } from "../../lib/args/common";
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
  /** automationIds whose definition lookup failed (their steps may be misclassified). */
  unresolvedServiceIds?: string[];
  /** --raw: the wire body exactly as the API returned it (once; not the parsed method). */
  raw?: HydratedMethod["raw"];
}

export const args = defineArgs({
  command: "belz ad fetch",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: { ...AD_V2_FLAG, raw: { type: "boolean" } },
});

const command: CommandModule<FetchMethodArgs, FetchMethodData> = {
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { uuid: resolveMethodRef(positionals.uuid), raw: flags.raw, apiVersion: apiVersionOf(flags) };
  },
  async execute({ uuid, raw, apiVersion }, context) {
    const method = await fetchMethodChecked(uuid, apiVersion); // V1 serves soft-deleted methods
    const unresolved = method.unresolvedServices ?? [];
    // A degraded parse (a definition lookup failed) is not cached (ADR-R11).
    if (unresolved.length === 0) await CacheManager.save(uuid, method);
    else context.warn(`Service definition lookup failed for ${unresolved.join(", ")}; the method was not cached.`);

    // V1-only: adApi.fetchMethod already looked every step up (AD-02); report
    // the ones it resolved, without re-requesting the failures (ADR-R12).
    const hydratedServiceIds: string[] = [];
    if (method.sourceVersion === "v1") {
      const failed = new Set(unresolved);
      for (const step of method.parsedSteps) {
        const id = step.automationId != null ? String(step.automationId) : null;
        if (id && !failed.has(id) && !hydratedServiceIds.includes(id)) hydratedServiceIds.push(id);
      }
    }

    if (hydratedServiceIds.length === 0 && unresolved.length === 0) {
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
      ...(unresolved.length ? { unresolvedServiceIds: unresolved } : {}),
    };

    if (raw) {
      data.raw = method.raw;
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
