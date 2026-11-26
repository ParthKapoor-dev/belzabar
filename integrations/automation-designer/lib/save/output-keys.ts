// Method outputs stored without a `key` (older methods keep only fieldCode /
// outputCode). The V1 runtime falls back to outputCode, but a V2 save drops
// it, and from then on every run fails "Cannot invoke Object.hashCode()
// because key is null". So every save writes the key from the fieldCode
// before posting, the way `set-output` repairs one output (K2).

import { isObj } from "@belzabar/core";
import type { V2OverlayPlan } from "../serialize/v2";

const KEY_RE = /^[A-Za-z0-9_]+$/;

interface FilledKey {
  /** Position in the saved body's `outputs`. */
  index: number;
  key: string;
}

/**
 * Fill every keyless method output of `plan.body` from its fieldCode (else
 * outputCode), in place, and add the write to what the post-save verify
 * checks. A code that is not a valid key, or already another output's key,
 * is left alone (OK1 still reports it).
 */
export function fillOutputKeys(plan: V2OverlayPlan): FilledKey[] {
  const outputs = Array.isArray(plan.body.outputs) ? (plan.body.outputs as unknown[]) : [];
  const taken = new Set(outputs.filter(isObj).map((o) => o.key).filter((k): k is string => typeof k === "string" && k.trim() !== ""));
  const filled: FilledKey[] = [];
  outputs.forEach((o, index) => {
    if (!isObj(o) || (typeof o.key === "string" && o.key.trim() !== "")) return;
    const code = [o.fieldCode, o.outputCode].find((c): c is string => typeof c === "string" && KEY_RE.test(c));
    if (!code || taken.has(code)) return;
    o.key = code;
    taken.add(code);
    filled.push({ index, key: code });
    const path = `outputs[${index}].key`;
    if (plan.structural) plan.structural.touched.push(path);
    else plan.targets.push({ key: `output ${code} key (filled)`, path, value: code });
  });
  return filled;
}

export function filledKeysWarning(filled: FilledKey[], tense: "filled" | "will be filled"): string {
  return (
    `Method output key ${tense} from the fieldCode for [${filled.map((f) => f.key).join(", ")}]: the output had no key, ` +
    `and after a V2 save without one every run fails "key is null".`
  );
}
