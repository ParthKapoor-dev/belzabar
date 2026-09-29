import { defineArgs, ok, type CommandModule } from "@belzabar/core";
import { fetchViewMethod } from "../../lib/view-fetch";
import type { ParsedStep } from "../../lib/types/common";
import { resolveMethodRef } from "../../lib/ids";
import { AD_COMMON_FLAGS, resolveAdCommon } from "../../lib/args/common";

interface OutputsArgs {
  uuid: string;
}

/** A value a step writes (CLI trial: `show --compact` listed `flatData[]→json` while `outputs` said nothing). */
interface StepOutputRow {
  step: number;
  /** The callee's output key (V2 `key`). */
  key: string;
  /** The name the method sees (`#{as}`), i.e. the step output's fieldCode. */
  as: string;
  /** Also written to this method variable (`var`). */
  var?: string;
  /** What `as` is declared as on the method; null = not declared (a step-local value). */
  declaredAs: "output" | "variable" | "input" | null;
}

interface OutputsData {
  uuid: string;
  name: string;
  sourceVersion: "v1" | "v2";
  inputs: Array<{ code: string; type: string; required: boolean; description: string }>;
  variables: Array<{ code: string; type: string; description: string }>;
  outputs: Array<{ code: string; type: string; displayName: string; description: string }>;
  stepOutputs: StepOutputRow[];
  notes?: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function stepOutputRows(steps: ParsedStep[], declared: { outputs: string[]; variables: string[]; inputs: string[] }): StepOutputRow[] {
  const rows: StepOutputRow[] = [];
  for (const [i, step] of steps.entries()) {
    for (const o of step.outputs ?? []) {
      const raw = isObj(o.raw) ? o.raw : {};
      const as = str(raw.fieldCode) ?? str(raw.name) ?? o.code;
      const ref = isObj(o.inputReference) ? str((o.inputReference as Obj).reference) : str(o.inputReference ?? o.internalVarRef);
      const declaredAs = declared.outputs.includes(as) ? "output" : declared.variables.includes(as) ? "variable" : declared.inputs.includes(as) ? "input" : null;
      rows.push({ step: i + 1, key: o.code || as, as, ...(ref ? { var: ref } : {}), declaredAs });
    }
  }
  return rows;
}

export const args = defineArgs({
  command: "belz ad outputs",
  positionals: [{ name: "uuid", required: true, missingCode: "MISSING_UUID", missingMessage: "Missing UUID argument." }],
  flags: { ...AD_COMMON_FLAGS },
});

const command: CommandModule<OutputsArgs, OutputsData> = {
  schema: "ad.outputs",
  parseArgs(argv) {
    const { positionals, flags } = args.parse(argv);
    resolveAdCommon(flags, "fetch", "outputs");
    return { uuid: resolveMethodRef(positionals.uuid) };
  },
  async execute({ uuid }, context) {
    // The same fresh V2 read as `show --compact`, so names agree (CLI trial).
    const m = await fetchViewMethod(uuid, (w) => context.warn(w));
    const declared = { outputs: m.outputs.map((o) => o.code), variables: m.variables.map((v) => v.code), inputs: m.inputs.map((i) => i.code) };
    const stepOutputs = stepOutputRows(m.parsedSteps, declared);
    const undeclared = [...new Set(stepOutputs.filter((r) => r.declaredAs === null).map((r) => r.as))];
    const notes = undeclared.length
      ? [`Written by steps but not declared as a method output/variable/input: ${undeclared.join(", ")}. The method does not return them (declare an output with that key to return one).`]
      : [];
    return ok<OutputsData>({
      uuid,
      name: m.name,
      sourceVersion: m.sourceVersion,
      inputs: m.inputs.map(i => ({
        code: i.code,
        type: String(i.type ?? ""),
        required: !!i.required,
        description: i.description ?? "",
      })),
      variables: m.variables.map(v => ({
        code: v.code,
        type: String(v.type ?? ""),
        description: v.description ?? "",
      })),
      outputs: m.outputs.map(o => ({
        code: o.code,
        type: String(o.type ?? ""),
        displayName: o.displayName ?? o.code,
        description: o.description ?? "",
      })),
      stepOutputs,
      ...(notes.length ? { notes } : {}),
    });
  },
  presentHuman(envelope, ui) {
    if (!envelope.ok) return;
    const data = envelope.data as OutputsData;
    ui.section(`${data.name} — Contract`);
    ui.section("Inputs");
    if (data.inputs.length === 0) ui.text("(none)");
    else ui.table(["Field", "Type", "Required", "Description"], data.inputs.map(i => [i.code, i.type, i.required ? "Yes" : "No", i.description]));
    ui.section("Variables");
    if (data.variables.length === 0) ui.text("(none)");
    else ui.table(["Field", "Type", "Description"], data.variables.map(v => [v.code, v.type, v.description]));
    ui.section("Outputs");
    if (data.outputs.length === 0) ui.text("(none)");
    else ui.table(["Code", "Display Name", "Type", "Description"], data.outputs.map(o => [o.code, o.displayName, o.type, o.description]));
    ui.section("Step outputs");
    if (data.stepOutputs.length === 0) ui.text("(none)");
    else ui.table(["Step", "Key", "As", "Var", "Declared as"], data.stepOutputs.map((r) => [r.step, r.key, r.as, r.var ?? "", r.declaredAs ?? "(not declared)"]));
    for (const n of data.notes ?? []) ui.info(n);
  },
};

export default command;
