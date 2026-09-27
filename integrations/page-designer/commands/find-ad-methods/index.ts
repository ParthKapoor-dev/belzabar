// belz pd find-ad-methods <input> [--component] [--recursive]
//
// AD method ids a page/component's HTTP calls execute. <input> is resolved
// like `pd show` (id, exact name, URL — PD-14 / F20: names used to be fetched
// as `/pages/<name>`). --recursive follows every referenced component (no
// components.json, PD-13 / F21); unresolvable ones are listed in `errors`.

import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { PD_FORCE_FLAG } from "../../lib/args/common";
import { analyzeItem, collectAllAdIds, type AnalyzeError } from "../../lib/analyzer";
import { adIdsOf } from "../../lib/extract";
import { parsePage } from "../../lib/parser/index";
import { resolveInput, resolveNameToId } from "../../lib/resolver";

interface FindAdMethodsArgs {
  targetId: string;
  recursive: boolean;
  component: boolean;
  force: boolean;
}

interface FindAdMethodsData {
  targetId: string;
  resolvedId: string;
  name: string;
  type: "PAGE" | "COMPONENT";
  recursive: boolean;
  adIds: string[];
  errors: AnalyzeError[];
}

export const args = defineArgs({
  command: "belz pd find-ad-methods",
  positionals: [
    { name: "id", required: true, missingCode: "MISSING_TARGET_ID", missingMessage: "Missing Page ID or Component ID argument." },
  ],
  flags: {
    component: { type: "boolean" },
    recursive: { type: "boolean", alias: ["-r"] },
    ...PD_FORCE_FLAG,
  },
});

const command: CommandModule<FindAdMethodsArgs, FindAdMethodsData> = {
  schema: "pd.find-ad-methods",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    return { targetId: positionals.id, recursive: flags.recursive, component: flags.component, force: flags.force };
  },
  async execute({ targetId, recursive, component, force }, context) {
    // --component: <input> is a component NAME (only components are considered).
    const input = component && !/^[0-9a-f]{32}$/i.test(targetId) ? await resolveNameToId(targetId, true) : targetId;
    const resolved = await resolveInput(input, force);
    const page = parsePage(resolved.response);

    let adIds: string[];
    const errors: AnalyzeError[] = [];
    if (recursive) {
      const report = await analyzeItem(resolved.resolvedId, page.name, new Set<string>(), errors);
      adIds = collectAllAdIds([report]);
      for (const e of errors) context.warn(`⚠ ${e.name}${e.id ? ` (${e.id})` : ""}: ${e.message}`);
    } else {
      adIds = adIdsOf(page);
    }

    return ok({
      targetId,
      resolvedId: resolved.resolvedId,
      name: page.name,
      type: resolved.entityType,
      recursive,
      adIds,
      errors,
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as FindAdMethodsData;
    if (data.adIds.length === 0) {
      ui.info("No AD method references found.");
      return;
    }
    ui.table(
      ["#", "AD Method ID"],
      data.adIds.map((id, idx) => [idx + 1, id])
    );
    ui.text(`Total: ${data.adIds.length}`);
  },
};

export default command;
