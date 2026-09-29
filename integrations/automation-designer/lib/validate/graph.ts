// L3 — cross-step reference graph.
//
// Symbols a step can read: method inputs, variables, and the output fieldCodes
// of earlier steps (a custom-code output's key too: the server rewrites
// fieldCode := key), plus platform helpers. Every `#{root…}` in step inputs,
// custom code, conditions and loop sources must resolve to one of them.

import { customCodeSource, loopConfig } from "./steps";
import { jsonPath, stepKind, stepRef, walkInputs } from "./schema";
import { scanSpel, spelRoots } from "./spel";
import { arr, isObj, nonBlank, str, type Report, type StepRef } from "./types";

/** Roots the platform provides in every SpEL context (LoggedInUser: seen on a dev env). */
export const PLATFORM_ROOTS = new Set(["util", "QUOTE", "ESCAPE", "JSON", "Math", "T", "LoggedInUser"]);
/** Per-step success flags the engine sets: serviceSuccess<step>[_<sub>] (seen on a dev env). */
const PLATFORM_ROOT_RE = /^serviceSuccess\d+(?:_\d+)*$/;

export function isPlatformRoot(name: string): boolean {
  return PLATFORM_ROOTS.has(name) || PLATFORM_ROOT_RE.test(name);
}

interface Sym {
  /** Names defined before step i (inputs, variables, outputs of steps < i). */
  before: Set<string>;
  /** Names written only by step i or later. */
  laterOrOwn: Set<string>;
  own: Set<string>;
}

export function checkGraph(body: Record<string, unknown>, report: Report): void {
  const steps = arr(body.steps);
  const inputs = arr(body.inputs).filter(isObj);
  const variables = arr(body.variables).filter(isObj);
  const inputKeys = inputs.map((f) => nonBlank(f.key)).filter((k): k is string => !!k);
  const varKeys = new Set(variables.map((f) => nonBlank(f.key)).filter((k): k is string => !!k));
  // A variable with no default that some step writes (inputReference) is empty
  // until its first writer has run: model the write as that step's output.
  const outputsOf = steps.map((s) => stepOutputNames(s));
  const lateVars = new Set<string>();
  for (const v of variables) {
    const k = nonBlank(v.key);
    if (!k || nonBlank(typeof v.defaultValue === "string" ? v.defaultValue : v.defaultValue == null ? undefined : String(v.defaultValue))) continue;
    const first = steps.findIndex((s) => isObj(s) && arr(s.outputs).some((o) => isObj(o) && isObj(o.inputReference) && o.inputReference.reference === k));
    if (first >= 0) {
      lateVars.add(k);
      outputsOf[first]!.push(k);
    }
  }
  const base = new Set<string>([...inputKeys, ...[...varKeys].filter((k) => !lateVars.has(k))]);

  if (steps.length === 0) {
    report({ rule: "AD-GRAPH-006", message: "The method has no steps; every output returns null.", path: "steps", evidence: "v2_empty_steps" });
  }

  // Method-level keys.
  const seenIn = new Map<string, number>();
  inputs.forEach((f, i) => {
    const k = nonBlank(f.key);
    if (!k) return;
    if (seenIn.has(k)) report({ rule: "AD-GRAPH-001", message: `Method input key "${k}" is declared twice (inputs[${seenIn.get(k)}] and inputs[${i}]).`, path: jsonPath(["inputs", i, "key"]) });
    else seenIn.set(k, i);
  });
  variables.forEach((v, i) => {
    const k = nonBlank(v.key);
    if (k && seenIn.has(k)) report({ rule: "AD-GRAPH-002", message: `Variable "${k}" has the same key as a method input; bindings become ambiguous.`, path: jsonPath(["variables", i, "key"]), fix: "Rename the variable." });
  });

  // Method outputs must be written by something.
  const methodOutputKeys = new Set<string>();
  const allStepNames = new Set<string>(outputsOf.flat());
  const stepOutputUuids = new Set<string>();
  for (const s of steps) for (const o of arr(isObj(s) ? s.outputs : []).filter(isObj)) {
    const u = nonBlank(o.uuid);
    if (u) stepOutputUuids.add(u.toLowerCase());
  }
  arr(body.outputs).forEach((o, i) => {
    if (!isObj(o)) return;
    const k = nonBlank(o.key);
    if (k) methodOutputKeys.add(k);
    const ref = k ?? nonBlank(o.fieldCode);
    if (!ref) return; // OK1 reports the missing key
    const refUuid = nonBlank(o.referenceUuid)?.toLowerCase();
    if (!allStepNames.has(ref) && !varKeys.has(ref) && !inputKeys.includes(ref) && !(refUuid && stepOutputUuids.has(refUuid))) {
      report({ rule: "M3", message: `Method output "${ref}" is not written by any step output, variable or input; it returns null.`, path: jsonPath(["outputs", i, "key"]), fix: "Name a step output fieldCode (or variable) after it, or remove the output.", evidence: "v2_method_output_unbound: returns null" });
    }
  });

  const seenIds = new Map<string, number>();
  const seenNames = new Map<string, number>();
  const seenCodes = new Map<string, number>();
  let deadAfter: number | null = null;

  steps.forEach((s, i) => {
    if (!isObj(s)) return;
    const ref = stepRef(s, i);
    const at = (...rest: Array<string | number>) => jsonPath(["steps", i, ...rest]);
    const props = isObj(s.properties) ? s.properties : {};
    const sym = symbolsAt(i, base, outputsOf);

    if (deadAfter !== null) {
      report({ rule: "AD-GRAPH-005", message: `Step ${i + 1} follows an unconditional exception.raise (step ${deadAfter + 1}) and can never run.`, path: jsonPath(["steps", i]), step: ref });
    }

    const id = nonBlank(s.id)?.toLowerCase();
    if (id) {
      if (seenIds.has(id)) report({ rule: "S3", message: `Step id is also used by step ${seenIds.get(id)! + 1}; the earlier step runs with its outputs dropped.`, path: at("id"), step: ref, evidence: "v2_dup_step_id" });
      else seenIds.set(id, i);
    }

    // References in inputs.
    walkInputs(s.inputs, ["steps", i, "inputs"], (inp, path) => {
      if (typeof inp.value === "string") checkRefs(inp.value, jsonPath([...path, "value"]), `Input "${str(inp.key) ?? "?"}"`, sym, "AD-REF-001", ref, report);
      const oref = isObj(inp.outputRef) ? inp.outputRef : undefined;
      const idx = oref?.referenceStepIndex;
      if (typeof idx === "number") {
        if (idx < 0 || idx >= steps.length) {
          report({ rule: "AD-GRAPH-003", message: `outputRef.referenceStepIndex ${idx} is outside 0..${steps.length - 1}.`, path: jsonPath([...path, "outputRef", "referenceStepIndex"]), step: ref, evidence: `500 Index ${idx} out of bounds for length ${steps.length}` });
        } else if (idx >= i) {
          report({ rule: "AD-GRAPH-004", message: `outputRef points at step ${idx + 1}, which runs at or after this step.`, path: jsonPath([...path, "outputRef", "referenceStepIndex"]), step: ref });
        }
      }
    });
    if (stepKind(s) === "CUSTOM_CODE" && isObj(props.customCode)) {
      const code = str(props.customCode.inlineCode);
      if (code) checkRefs(customCodeSource(code), at("properties", "customCode", "inlineCode"), "Custom code", sym, "AD-REF-001", ref, report);
    }

    // Conditions: entry sees earlier steps; a conditional exit also sees this step's outputs.
    const entry = isObj(props.entryCondition) ? str(props.entryCondition.expression) : undefined;
    if (entry) checkRefs(entry, at("properties", "entryCondition", "expression"), "Entry condition", sym, "CR1", ref, report);
    const cexit = isObj(props.exitCondition) && isObj(props.exitCondition.conditionalExit) ? str(props.exitCondition.conditionalExit.expression) : undefined;
    if (cexit) {
      const withOwn: Sym = { before: new Set([...sym.before, ...sym.own]), laterOrOwn: sym.laterOrOwn, own: sym.own };
      checkRefs(cexit, at("properties", "exitCondition", "conditionalExit", "expression"), "Conditional exit", withOwn, "CR1", ref, report);
    }

    // Loops.
    const loop = loopConfig(props);
    if (loop) {
      const counter = nonBlank(loop.counter);
      const cm = counter ? /^#\{([^}]+)\}$/.exec(counter) : null;
      if (cm) {
        const cvar = cm[1]!.trim().split(/[.[]/)[0]!;
        if (!varKeys.has(cvar)) report({ rule: "LP4", message: `Loop counter variable "${cvar}" is not declared in variables[].`, path: at("properties", "repeatStepExecution", "counter"), step: ref });
      }
      if (loop.type === "LOOP_EXECUTION_ON_INPUT_OUTPUT" && typeof loop.value === "string") {
        checkRefs(loop.value, at("properties", "repeatStepExecution", "value"), "Loop value", sym, "LP6", ref, report);
      }
    }

    // Outputs.
    const runAsync = props.runAsync === true;
    arr(s.outputs).forEach((o, j) => {
      if (!isObj(o)) return;
      const ir = isObj(o.inputReference) ? nonBlank(o.inputReference.reference) : undefined;
      if (ir) {
        if (!varKeys.has(ir)) report({ rule: "SV1", message: `Output writes variable "${ir}" (inputReference), which is not declared in variables[]; the write is lost.`, path: at("outputs", j, "inputReference", "reference"), step: ref, fix: `Declare variable "${ir}".`, evidence: "v2_var_undeclared_ref: reader sees empty" });
        for (const f of ["name", "fieldCode"] as const) {
          if (!nonBlank(o[f])) report({ rule: "VB1", message: `Output writing variable "${ir}" has an empty ${f}; the save rejects it and the UI drops the binding.`, path: at("outputs", j, f), step: ref });
        }
      }
      const nm = nonBlank(o.name);
      const fc = nonBlank(o.fieldCode);
      if (nm) {
        if (seenNames.has(nm)) report({ rule: "DUP1", message: `Output name "${nm}" is also used by step ${seenNames.get(nm)! + 1}; the UI keeps only one.`, path: at("outputs", j, "name"), step: ref });
        else seenNames.set(nm, i);
      }
      if (fc) {
        if (seenCodes.has(fc)) report({ rule: "DUP1", message: `Output fieldCode "${fc}" is also written by step ${seenCodes.get(fc)! + 1}; last write wins.`, path: at("outputs", j, "fieldCode"), step: ref, evidence: "v2_dup_out_fieldcode: the other method output goes null" });
        else seenCodes.set(fc, i);
      }
      const writesMethodOutput = (fc && methodOutputKeys.has(fc)) || (ir && methodOutputKeys.has(ir));
      if (runAsync && writesMethodOutput) {
        report({ rule: "AS1", message: `runAsync step writes method output "${fc ?? ir}"; the response is assembled without waiting for async steps.`, path: at("properties", "runAsync"), step: ref, fix: "Make the step synchronous, or give it outputs: [] if it is side-effect only." });
      }
    });

    if (deadAfter === null && stepKind(s) === "EXCEPTION" && !nonBlank(isObj(props.entryCondition) ? props.entryCondition.expression : undefined) && !loop) {
      deadAfter = i;
    }
  });
}

function stepOutputNames(s: unknown): string[] {
  if (!isObj(s)) return [];
  const names: string[] = [];
  const cc = stepKind(s) === "CUSTOM_CODE";
  for (const o of arr(s.outputs).filter(isObj)) {
    const fc = nonBlank(o.fieldCode);
    if (fc) names.push(fc);
    if (cc) {
      const k = nonBlank(o.key);
      if (k) names.push(k);
    }
  }
  return names;
}

function symbolsAt(i: number, base: Set<string>, outputsOf: string[][]): Sym {
  const before = new Set(base);
  for (let k = 0; k < i; k++) for (const n of outputsOf[k]!) before.add(n);
  const laterOrOwn = new Set<string>();
  for (let k = i; k < outputsOf.length; k++) for (const n of outputsOf[k]!) laterOrOwn.add(n);
  return { before, laterOrOwn, own: new Set(outputsOf[i] ?? []) };
}

function checkRefs(text: string, path: string, where: string, sym: Sym, undefinedRule: string, ref: StepRef, report: Report): void {
  if (!text.includes("#{")) return;
  const missing = new Set<string>();
  const later = new Set<string>();
  for (const b of scanSpel(text).blocks) {
    for (const root of spelRoots(b.body)) {
      if (sym.before.has(root) || isPlatformRoot(root)) continue;
      if (sym.laterOrOwn.has(root)) later.add(root);
      else missing.add(root);
    }
  }
  for (const name of missing) {
    report({
      rule: undefinedRule,
      message: `${where} reads #{${name}}, which no input, variable or earlier step output defines${undefinedRule === "CR1" ? "; the step is silently skipped" : "; the literal text propagates"}.`,
      path,
      step: ref,
      fix: `Declare "${name}" (input/variable) or fix the name.`,
      evidence: undefinedRule === "CR1" ? "v2_entry_cond_undeclared: step skipped, run green" : "v2_spel_dangling_ref / v2_input_key_renamed_dangling",
    });
  }
  for (const name of later) {
    report({
      rule: undefinedRule === "LP6" ? "LP6" : "AD-REF-002",
      message: `${where} reads #{${name}}, which is only written by this or a later step; it reads empty here.`,
      path,
      step: ref,
      fix: "Move the writer before this step.",
      evidence: "v2_step_reorder: reader sees empty",
    });
  }
}
