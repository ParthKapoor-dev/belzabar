# ROADMAP.md - Belz-AI Capability-Gated Rolling Release Plan

## Roadmap Model

This roadmap is capability-gated and timeline-agnostic.

1. Progress is defined by passing acceptance criteria, not by dates.
2. Rolling-release means frequent incremental shipping.
3. Any gate can be revisited if requirements evolve.

## Strategic Tracks

1. Skills and Context Packs.
2. Orchestration Runtime (Web App + Main Orchestrator).
3. Worker Runtime and Adapter Layer (ACP-aligned).
4. Repository Documentation and Maintainer Enablement.
5. Reliability, Quality, and Observability.

## Gate V1-G0: Foundation Contracts and Governance

### Goal

Lock architecture and contracts before scaling runtime behavior.

### Deliverables

1. Canonical architecture charter (`specs/AIM.md`).
2. Versioned schema definitions for:
- request envelope
- resolved context
- worker task
- worker result
- diagnosis report
3. Session state layout specification.
4. Rolling-release governance rules.

### Acceptance Criteria

1. Required schemas exist and are versioned.
2. Contract-breaking change policy is documented.
3. Maintainer can infer architecture from docs only.

## Gate V1-G1: Single-Agent Contextful Runtime

### Goal

Ship a minimal web-app driven runtime with one contextful main orchestrator.

### Deliverables

1. Web app can start and resume sessions.
2. Main orchestrator can process flexible request formats.
3. Session context persists as machine + human snapshots.
4. Diagnosis output follows required schema.

### Acceptance Criteria

1. At least three distinct input styles work without prompt rewrites.
2. Final output conforms to diagnosis contract.
3. Session replay from stored state is possible.

## Gate V1-G2: Delegation Baseline (Sequential Workers)

### Goal

Introduce worker delegation to reduce orchestrator context rot.

### Deliverables

1. Worker task families:
- method summarization
- service localization
- failure analysis
- fix drafting
- evidence extraction
2. Sequential worker executor with retries/timeouts.
3. Structured evidence artifact capture per worker run.
4. Orchestrator synthesis over worker outputs.

### Acceptance Criteria

1. Heavy method analysis is delegated by default.
2. Worker failure degrades gracefully with confidence downgrade.
3. Orchestrator context remains compact across deep AD methods.

## Gate V1-G3: ACP-Aligned Adapter Layer

### Goal

Enable provider changes without orchestration rewrites.

### Deliverables

1. Unified ACP-shaped worker adapter interface.
2. Stdio-first adapters or ACP shims for selected coding-agent CLIs.
3. Provider capability registry and fallback behavior.
4. Adapter contract test suite.

### Acceptance Criteria

1. Same worker task contract runs across at least two providers.
2. Provider swap is config-level, not orchestration-code-level.
3. Output schema stays stable across adapters.

## Gate V1-G4: Skills System Maturity

### Goal

Operationalize structured skills/context packs as first-class runtime assets.

### Deliverables

1. Versioned skill catalog by domain/tool/task.
2. Skill composition strategy by request/task type.
3. Skill changelog and deprecation policy.
4. "Important findings" capture format for maintainer consumption.

### Acceptance Criteria

1. Worker startup uses only minimal needed skills.
2. Skill updates are traceable and reversible.
3. At least one runtime finding is converted into a documented skill update.

## Gate V1-G5: Maintainer-Ready Repository

### Goal

Make repository structure and docs easy for maintainers and coding agents to work in.

### Deliverables

1. Current-state docs synchronized with real implementation.
2. Project map + decision log + contract index.
3. Maintainer runbook for adding features, adapters, and skills.
4. Explicit list of known gaps and their intended gate targets.

### Acceptance Criteria

1. A new maintainer can make first meaningful change from docs.
2. Contracts, roadmap, and skill docs are cross-linked and coherent.
3. Known limitations are explicit and not hidden in ad-hoc notes.

## Gate V1-G6: Operational Hardening

### Goal

Stabilize v1 for high-frequency rolling releases.

### Deliverables

1. Regression matrix for intake, resolver, delegation, and report contracts.
2. Observability baseline:
- session events
- task outcomes
- failure categories
- confidence drift indicators
3. Rollback procedure for bad increments.
4. Release checklist covering contracts/docs compatibility.

### Acceptance Criteria

1. Critical path regressions are automatically detectable.
2. Failed release can be rolled back with documented steps.
3. Every increment updates docs and contract impact notes.

## V1.x Expansion Gates (Post-Core)

1. Policy Modes:
- Introduce redaction/retention profiles for broader team use.
2. Confidence Calibration:
- Improve confidence scoring and evidence ranking.
3. Optional Parallel Workers:
- Add parallel execution behind a capability flag.
4. Module Readiness:
- Prepare clean seams for Teamwork/PD/browser-assisted integrations.

## V2 Directional Gates

1. Multi-module orchestrator workflows (AD + PD + external context).
2. Human-approved automation helpers (dev-note/ticketing assist).
3. Advanced issue reproduction modules where required.
4. Multi-user governance with safer default policies.

## Rolling-Release Operating Rules

1. No fixed dates in this roadmap.
2. Ship when gate criteria pass.
3. Schema breakage requires version bump and migration guidance.
4. Each increment must document:
- what changed
- contract impact
- skill/context impact
- rollback notes

## Backlog Intake Rules

1. Every item must map to exactly one strategic track and at least one gate.
2. Items without acceptance criteria are not implementation-ready.
3. Emergency fixes can bypass order but must retro-document contract impact.

## Progress Reporting Template

For each gate, track:

1. Status: `not-started | in-progress | blocked | complete`
2. Completed criteria.
3. Remaining criteria.
4. Risks.
5. Next unblock action.
