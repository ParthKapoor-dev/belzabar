// Rule catalogue: every code the validator can emit, with its default
// severity and layer. Codes from the team's `validate.py` (M1, IK1, CI1, LP3…)
// keep their names and meaning; wi-impl-only rules are `AD-<FAMILY>-nnn`.
//
// Doc contradictions resolved here (agents-repo-research §6b):
//   - a single ternary is fine; SP1 warns only on ≥2 (nested) ternaries;
//   - a dotted variable key is rejected live (VK1), whatever method-json.md says;
//   - method names allow `[A-Za-z0-9_.~-]`, no leading/trailing `.` (M1).
// Severity changes vs validate.py, with the live evidence (ad-validation §4):
//   - CC2 no longer requires base64: a dev env stores most code plain and the
//     runtime content-sniffs; CC2 = inlineCode missing/blank only;
//   - CC5 (bad executor) and CC1 (language outside the server enum) are errors:
//     the server rejects them with 400 (v2_cc_executor_bad / _language_bad);
//   - CR1 (entry condition reads an undefined name) is an error: the step is
//     silently skipped and the run stays green (v2_entry_cond_undeclared).
//   - CI1 and DUP1 are warnings: 58 CI1 and 5 DUP1 hits on the 36
//     real a dev env bodies, 8 of them PUBLISHED and running. SpEL with
//     combineInput:false runs via the API (only the UI runner cannot run it),
//     and a fieldCode written by two steps is often an intentional overwrite
//     (research §4.2: "warn: some real methods do this"). --strict blocks new ones.

import type { Severity } from "./types";

type Layer = "L1" | "L2" | "L3" | "L4";

interface RuleInfo {
  severity: Severity;
  layer: Layer;
  description: string;
}

export const RULES = {
  // ── L1 structural ──────────────────────────────────────────────────────
  "AD-SCHEMA-001": { severity: "error", layer: "L1", description: "A field has the wrong JSON type (e.g. exitOnFailure.value \"yes\", inputReference \"\"); the server rejects the body" },
  "AD-SCHEMA-002": { severity: "error", layer: "L1", description: "Method input/variable/output type is not a known data type (server 500, no field named)" },
  "AD-SCHEMA-003": { severity: "warn", layer: "L1", description: "A uuid is neither 32 hex (optionally space-padded) nor dashed 36 characters" },
  "AD-META-001": { severity: "error", layer: "L1", description: "metadata.state is PUBLISHED in a save body (400 'Draft referenceId is mandatory')" },
  "AD-META-002": { severity: "error", layer: "L1", description: "An update body (has uuid) is missing metadata.version/service/internal (400 'Invalid state')" },
  M1: { severity: "error", layer: "L1", description: "Method name missing or invalid: [A-Za-z0-9_.~-], no leading/trailing '.' (400 invalid_method_name)" },
  M2: { severity: "error", layer: "L1", description: "Method has no steps array (a V1 body with services[] is rejected)" },
  IK1: { severity: "error", layer: "L1", description: "Method input key not ^[A-Za-z0-9_]+$ (400 invalid_input_key)" },
  VK1: { severity: "error", layer: "L1", description: "Variable key not ^[A-Za-z0-9_]+$; dotted keys are rejected live (400 invalid_internal_variable_key)" },
  OK1: { severity: "error", layer: "L1", description: "Method output has no key, or an invalid one (save 200, then every run NPEs)" },
  ON1: { severity: "error", layer: "L1", description: "Method output name not ^[A-Za-z0-9_]+$ (400 invalid_output_name)" },
  S1: { severity: "error", layer: "L1", description: "Step properties missing (500 NPE) or properties.type not EXISTING_SERVICE|CUSTOM_CODE (400)" },
  S2: { severity: "warn", layer: "L1", description: "Step id is not a uuid (the server replaces it)" },
  NC1: { severity: "error", layer: "L1", description: "Step output name/fieldCode not ^[A-Za-z0-9_]+$ (400 invalid_step_output_name/_field_code)" },
  "AD-OUT-001": { severity: "error", layer: "L1", description: "Step output fieldCode or name missing/empty (400 on empty, 500 NPE on null)" },
  "AD-OUT-002": { severity: "error", layer: "L1", description: "Step output has no key (the service output it binds)" },
  EI1: { severity: "error", layer: "L1", description: "Step input missing key" },
  EI2: { severity: "warn", layer: "L1", description: "Step input type not a known data type" },
  ES1: { severity: "error", layer: "L1", description: "EXISTING_SERVICE step has neither automationAPIId nor serviceName+methodName" },
  ES2: { severity: "warn", layer: "L1", description: "automationAPIId is not a 32-hex (padded) or dashed uuid" },
  // ── L2 per step ────────────────────────────────────────────────────────
  CC1: { severity: "error", layer: "L2", description: "Custom code language missing (runtime NPE) or outside the server enum (400); JAVA/COBOL/PERL warn" },
  CC2: { severity: "error", layer: "L2", description: "Custom code inlineCode missing or blank" },
  CC3: { severity: "warn", layer: "L2", description: "Last code line has no console.log()/print(); the runtime captures the last printed line" },
  CC4: { severity: "error", layer: "L2", description: "More than one output but the code never JSON.stringify()/json.dumps()" },
  CC5: { severity: "error", layer: "L2", description: "Executor outside CODE_LAMBDA|NODEJS_LAMBDA|INTERNAL_SERVER (400); NODEJS_LAMBDA warns (deprecated)" },
  CO1: { severity: "error", layer: "L2", description: "Custom code output type missing or not a known data type" },
  CO2: { severity: "error", layer: "L2", description: "Custom code output has no name" },
  "AD-CC-001": { severity: "error", layer: "L2", description: "JavaScript source does not parse (runtime SyntaxError, later steps skipped)" },
  "AD-CC-002": { severity: "error", layer: "L2", description: "Multi-output custom code without elementToRetrieve on every output (first output gets the whole JSON, the rest stay unbound)" },
  "AD-CC-003": { severity: "error", layer: "L2", description: "Custom code output key differs from fieldCode (the server rewrites fieldCode := key; readers of the old fieldCode get null)" },
  "AD-CC-004": { severity: "warn", layer: "L2", description: "Single output elementToRetrieve names a key the source never prints (the output stays unbound)" },
  SQL1: { severity: "error", layer: "L2", description: "SQL queryString looks base64 but encodingType is not BASE_64 (the DB runs the encoded text)" },
  ENC1: { severity: "warn", layer: "L2", description: "Input flagged BASE_64/encodedBase64 but its value is not valid base64 (not decoded)" },
  "AD-SQL-001": { severity: "error", layer: "L2", description: "SQL step has no queryString" },
  "AD-SQL-002": { severity: "error", layer: "L2", description: "SQL step has no accountConfiguration.id (runtime 'Failed to execute automation!')" },
  "AD-SQL-003": { severity: "warn", layer: "L2", description: "SQL statement verb does not match the step operation (e.g. UPDATE in data.read)" },
  "AD-SQL-004": { severity: "warn", layer: "L2", description: "#{…} spliced into queryString; use :param + body.queryParams" },
  Q1: { severity: "error", layer: "L2", description: "Bare '?' (jsonb ?/?|/?&) in platform-executed SQL fails with 'given N parameters but expected 0'; use @> / jsonb_exists" },
  Q5: { severity: "error", layer: "L2", description: "Autoformat damage in SQL: curly quotes or '-»' outside a string literal (error); en/em dash (warn)" },
  CI1: { severity: "warn", layer: "L2", description: "Step input holds SpEL with combineInput:false ('This Exactly'); runs via API but not from the AD UI" },
  SP1: { severity: "warn", layer: "L2", description: "Step-input SpEL with ≥2 ternaries, >4 chained operators or >200 chars; move branching to an entryCondition" },
  "AD-SPEL-001": { severity: "error", layer: "L2", description: "Unclosed #{ (the literal text becomes the value)" },
  "AD-SPEL-002": { severity: "error", layer: "L2", description: "Nested #{ #{…} } is not supported (the literal propagates)" },
  "AD-SPEL-003": { severity: "error", layer: "L2", description: "#{#var} is not supported; write #{var}" },
  "AD-SPEL-004": { severity: "error", layer: "L2", description: "Inline list/map literal #{ {…} } breaks the #{} delimiter" },
  "AD-SPEL-005": { severity: "error", layer: "L2", description: "SpEL syntax error: empty, unbalanced, or dangling operator (step fails / is skipped)" },
  "AD-SPEL-006": { severity: "warn", layer: "L2", description: "defaultValue contains #{…}; defaults are stored literally, never evaluated" },
  "AD-COND-001": { severity: "error", layer: "L2", description: "Condition expression has no #{…}; it compares constants and the step is silently skipped" },
  "AD-COND-002": { severity: "warn", layer: "L2", description: "Basic-mode condition rows disagree with the expression (the runtime uses the expression, the UI shows the rows)" },
  AS1: { severity: "error", layer: "L3", description: "runAsync step writes a method output; the response does not wait for async steps" },
  LP1: { severity: "warn", layer: "L2", description: "Unknown repeatStepExecution.type (the server drops the loop)" },
  LP2: { severity: "error", layer: "L2", description: "Loop missing its required value (ON_INPUT_OUTPUT without value: every run 500)" },
  LP3: { severity: "error", layer: "L2", description: "Loop counter is not #{varName}" },
  LP4: { severity: "error", layer: "L2", description: "Loop counter variable not declared in variables[]" },
  LP5: { severity: "warn", layer: "L2", description: "Unrecognized loop field (silently ignored)" },
  // ── L3 graph ───────────────────────────────────────────────────────────
  LP6: { severity: "warn", layer: "L3", description: "ON_INPUT_OUTPUT loop value reads a name that is not an input, variable or prior step output" },
  CR1: { severity: "error", layer: "L3", description: "Entry/exit condition reads an undefined name (the step is silently skipped)" },
  "AD-REF-001": { severity: "error", layer: "L3", description: "#{name} in a step input or code reads a name nothing defines (the literal propagates)" },
  "AD-REF-002": { severity: "warn", layer: "L3", description: "#{name} is only written by this or a later step (the reader sees empty)" },
  SV1: { severity: "error", layer: "L3", description: "Output inputReference targets an undeclared variable (the write is lost)" },
  VB1: { severity: "error", layer: "L3", description: "A variable-writing output has an empty name or fieldCode" },
  M3: { severity: "error", layer: "L3", description: "Method output is not written by any step output, variable or input (returns null)" },
  S3: { severity: "error", layer: "L3", description: "Duplicate step id (the earlier step runs with its outputs dropped)" },
  DUP1: { severity: "warn", layer: "L3", description: "Two step outputs share a name or fieldCode (last write wins; the UI de-dups one)" },
  "AD-GRAPH-001": { severity: "error", layer: "L3", description: "Duplicate method input key" },
  "AD-GRAPH-002": { severity: "error", layer: "L3", description: "Variable key equals a method input key (ambiguous binding)" },
  "AD-GRAPH-003": { severity: "error", layer: "L3", description: "outputRef.referenceStepIndex out of range (500 'Index n out of bounds')" },
  "AD-GRAPH-004": { severity: "warn", layer: "L3", description: "outputRef points at the same or a later step" },
  "AD-GRAPH-005": { severity: "warn", layer: "L3", description: "Step follows an unconditional exception.raise and can never run" },
  "AD-GRAPH-006": { severity: "warn", layer: "L3", description: "Method has no steps (every output returns null)" },
  // ── L4 online ──────────────────────────────────────────────────────────
  "AD-SVC-001": { severity: "error", layer: "L4", description: "serviceName/methodName does not resolve to an automation API (404 on save)" },
  "AD-SVC-002": { severity: "warn", layer: "L4", description: "automationAPIId differs from the API named by serviceName/methodName (the id wins; a bogus id fails 500)" },
  "AD-SVC-003": { severity: "error", layer: "L4", description: "Step input key not in the callee contract and no matching uuid (the input is silently dropped)" },
  "AD-SVC-004": { severity: "warn", layer: "L4", description: "Step input key not in the callee contract but its uuid matches (the server repairs the key)" },
  "AD-SVC-005": { severity: "error", layer: "L4", description: "accountConfiguration.id is not an account of the step's service (500 on save)" },
  "AD-SVC-006": { severity: "warn", layer: "L4", description: "Online lookup failed; the step's contract was not checked" },
  "AD-COMPILE-001": { severity: "error", layer: "L4", description: "Server dry-run compile rejected the method (400 'Error while compiling automation')" },
  "AD-COMPILE-002": { severity: "error", layer: "L4", description: "Server dry-run compile answered another non-2xx (500 'automationAPI is null', bad account, 400 'Invalid state'): the method was refused" },
} as const satisfies Record<string, RuleInfo>;

export function ruleInfo(code: string): RuleInfo | undefined {
  return (RULES as Record<string, RuleInfo>)[code];
}
