// K8: a rename onto a name or alias that another method of the category holds.
//
// The server refuses it on the save ("A method or alias with this name already
// exists in the service", 400 duplicate_method_name). A method's alias
// (`aliasName`: V1 chain and API records, not in the V2 body) is its first
// name and survives every rename; neither the AD screen nor any route changes
// it, so an old name stays taken by the renamed method (live). The match is
// exact (case-sensitive, live). The check reads the category listing: every
// unpublished draft and every published method; a draft with a published copy
// is seen as that copy (its own unpublished name is not listed).

import { fetchMethodsForCategory } from "../method-finder";
import type { V2MethodResponse } from "../types/v2-wire";

export interface NameConflict {
  /** The name the save would set. */
  name: string;
  /** Which of the holder's names it equals. */
  matched: "name" | "alias";
  holder: { uuid: string; state: string; name: string; alias: string };
}

/**
 * The method holding `after.name` in the draft's category, when the save
 * renames the method; null when there is none (or no rename). A listing that
 * fails is a warning, not a refusal (the server still checks).
 */
export async function findNameConflict(input: {
  live: V2MethodResponse;
  after: V2MethodResponse;
  /** The draft and its published copy: their own names never conflict. */
  self: Array<string | null | undefined>;
  warn: (msg: string) => void;
}): Promise<NameConflict | null> {
  const name = typeof input.after.name === "string" ? input.after.name : "";
  if (!name || name === input.live.name) return null;
  const category = input.live.metadata?.service;
  if (!category?.uuid) return null;
  const self = new Set(input.self.filter((u): u is string => !!u).map((u) => u.trim().toLowerCase()));
  const listed = await fetchMethodsForCategory({ uuid: category.uuid.trim(), name: category.name });
  if (listed.error) {
    input.warn(`Could not check whether '${name}' is free in ${category.name} (${listed.error}); the server still refuses a taken name or alias.`);
  }
  for (const m of listed.methods) {
    if (self.has(m.uuid.toLowerCase()) || (m.referenceId && self.has(m.referenceId.trim().toLowerCase()))) continue;
    const matched = m.methodName === name ? "name" : m.aliasName === name ? "alias" : null;
    if (matched) return { name, matched, holder: { uuid: m.uuid, state: m.state, name: m.methodName, alias: m.aliasName } };
  }
  return null;
}

export function nameConflictMessage(c: NameConflict, category: string): string {
  const who = `${c.holder.state} ${c.holder.uuid} (name '${c.holder.name}'${c.holder.alias && c.holder.alias !== c.holder.name ? `, alias '${c.holder.alias}'` : ""})`;
  return (
    `'${c.name}' is already the ${c.matched} of ${who} in ${category}; the server refuses the rename ` +
    `("A method or alias with this name already exists").` +
    (c.matched === "alias" ? " An alias (usually the method's first name) stays after a rename; no AD screen or route changes it, so pick another name." : "")
  );
}
