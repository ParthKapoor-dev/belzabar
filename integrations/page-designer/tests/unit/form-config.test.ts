// F3: page logic inside exp-form-builder configs (a generated variable, not
// the layout tree) is visible to --var-graph, --node, --find and --var-detail.
// Over the real offer_response_component, whose form fields write page
// variables from their valueChange / click handlers.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";
import show from "../../commands/show/index";
import { findInCode, findNodes, varDetail } from "../../lib/extract";
import { formConfigs, formRefs } from "../../lib/form-config";
import { findNode, parsePage } from "../../lib/parser/index";
import { ENV, run, startFakePd, type FakePd } from "./helpers/fake-pd";
import { loadReal } from "./helpers/real";
import type { RawPageResponse } from "../../lib/types/wire";

const OFFER = "4ccf5f0bf66cc647f10aa47a0dc9d8c7";
const FORM = "__form_config_var123_852653_771613";
const FORM_NODE = "__node_id_179_303937_884337_510726";
const p = parsePage(loadReal(OFFER));

describe("formConfigs / formRefs", () => {
  test("every form variable, its builder node and its own node trees", () => {
    const forms = formConfigs(p);
    expect(forms.map((f) => f.variable)).toEqual(["__form_config_var548_285201_435735", FORM]);
    const f = forms[1]!;
    expect(f.builderNodeIds).toHaveLength(1);
    expect(findNode(p.layout, f.builderNodeIds[0]!)!.tagName).toBe("exp-form-builder");
    expect(f.trees.map((t) => t.nodeId)).toContain(FORM_NODE);
    expect(f.trees[0]!.path).toMatch(/^variables\.generated\[\d+\]\.initialValue\.form\.fields\[\d+\]\.layoutConfig$/);
    // The page's own layout does not contain the form's nodes.
    expect(findNode(p.layout, FORM_NODE)).toBeNull();
  });

  test("event handlers inside the form write page variables", () => {
    const writes = formRefs(p).writes.filter((w) => w.form === FORM);
    expect(writes.map((w) => w.variable)).toEqual(
      expect.arrayContaining(["responseSelected", "seriousMedicalConditionOpts", "otherSeriousMedConditions", "finalMedicationsList"]),
    );
    expect(writes.find((w) => w.variable === "otherSeriousMedConditions")).toMatchObject({ via: "event:valueChange" });
  });
});

describe("read views", () => {
  test("--find sees nodes inside forms (with form) and form text outside node trees", () => {
    expect(findNodes(p, FORM_NODE)).toEqual([expect.objectContaining({ id: FORM_NODE, match: "id", form: FORM })]);
    const handler = findNodes(p, "getVariableValue('otherSeriousMedConditions')");
    expect(handler.length).toBeGreaterThan(0);
    expect(handler.every((m) => m.form === FORM)).toBe(true);
    expect(findInCode(p, FORM_NODE)).toEqual([]); // node trees are findNodes' job, not repeated as code
  });

  test("--var-detail reads a form variable", () => {
    const d = varDetail(p, FORM)!;
    expect(d).toMatchObject({ kind: "form-config", name: FORM, builderNodeIds: [expect.any(String)] });
    expect((d.initialValue as { form: unknown }).form).toBeDefined();
  });
});

describe("pd show over the fake server", () => {
  let pd: FakePd;
  beforeEach(() => {
    rmSync(join(BELZ_CONFIG_DIR, "cache", "pages", ENV), { recursive: true, force: true });
    pd = startFakePd([{ ...loadReal(OFFER), referenceId: null } as RawPageResponse]);
  });
  afterEach(() => pd.restore());

  test("--var-graph lists writers inside the form config (they had none)", async () => {
    const data = (await run(show, [OFFER, "--var-graph", "--force"])).envelope!.data as any;
    const v = data.varGraph.find((e: { name: string }) => e.name === "otherSeriousMedConditions");
    expect(v.writtenByEvents).toContainEqual(expect.objectContaining({ event: "valueChange", form: FORM }));
    const formVar = data.varGraph.find((e: { name: string }) => e.name === FORM);
    expect(formVar).toMatchObject({ kind: "form-config", readByBindings: [expect.objectContaining({ prop: "[formConfig]" })] });
  });

  test("--node finds a node inside a form config", async () => {
    const r = await run(show, [OFFER, "--node", FORM_NODE, "--force"]);
    expect(r.envelope!.ok).toBe(true);
    expect((r.envelope!.data as any).nodeDetail).toMatchObject({ nodeId: FORM_NODE, form: FORM, path: expect.stringContaining(".layoutConfig") });
  });

  test("--var-detail on a form variable; an unknown name hints at form configs", async () => {
    expect(((await run(show, [OFFER, "--var-detail", FORM, "--force"])).envelope!.data as any).varDetail.kind).toBe("form-config");
    const miss = await run(show, [OFFER, "--var-detail", "[formConfig]", "--force"]);
    expect(miss.envelope!.error).toMatchObject({ code: "VAR_NOT_FOUND", message: expect.stringContaining("[formConfig]") });
  });
});
