# AIM.md - Belz-AI Architecture Charter

## Purpose

Belz-AI exists to reduce the time and effort required to diagnose and fix Automation Designer (AD) issues at Belzabar by combining:

1. AD-focused CLI tooling.
2. A context-aware main orchestrator agent.
3. Specialized worker agents for bounded tasks.

This document is normative and intentionally implementation-agnostic.  
Keywords `MUST`, `SHOULD`, and `MAY` are used in RFC-style meaning.

## Scope of This Charter

1. Define architecture direction and non-negotiable constraints.
2. Define role boundaries between orchestrator, workers, and maintainer workflows.
3. Define how requirements evolve from v1 to later versions.
4. Ensure rolling-release development remains structured and upgrade-safe.

Detailed sequencing and gate criteria are defined in `specs/ROADMAP.md`.

## Product Intent

1. Primary intent: accelerate AD debugging and fix planning.
2. Secondary intent: build an extensible agentic platform that can later include PD, Teamwork inputs, browser-replay workflows, and migration assistance.
3. Initial operating model: single user, but architecture must remain multi-user extensible.

## Core Principles

### 1) Delegation First

1. Main orchestrator MUST delegate non-strategic heavy analysis to workers.
2. Worker tasks MUST be bounded with explicit input/output contracts.
3. Orchestrator SHOULD reserve context for planning, synthesis, and decision quality.

### 2) Flexible Intake

1. The system MUST accept multiple request styles:
- cURL/API issue reports
- AD method UUID only
- free-form engineering questions
- mixed context prompts
2. Intake format MUST NOT be constrained to one template.

### 3) AD-First, Not AD-Locked

1. v1 runtime scope is AD diagnosis.
2. Architecture MUST expose extension seams for future capabilities.
3. Current scope MUST NOT create structural constraints for adding PD and other modules.

### 4) Rolling Release

1. Delivery model is rolling release.
2. Capability gates MUST determine progression, not calendar dates.
3. Each release increment MUST maintain docs/contracts coherence.

### 5) Stable Contracts

1. All machine-facing outputs MUST be schema-versioned.
2. Contract-breaking changes MUST trigger explicit version bumps and migration notes.
3. Provider-specific behavior MUST be isolated behind adapter interfaces.

### 6) Context Discipline

1. Session context MUST be persisted in compact, resumable form.
2. Context persistence MUST support cross-session continuation.
3. Evidence artifacts MUST be retained per session for auditability.

## Required Agent Roles

### Main Orchestrator (Runtime, User-Facing)

MUST:
1. Parse user intent from flexible inputs.
2. Plan and delegate worker tasks.
3. Synthesize evidence into diagnosis and fix strategy.
4. Produce final structured report with confidence.

### Worker Agents (Runtime, Task-Facing)

MUST:
1. Execute bounded tasks only.
2. Return structured outputs with evidence.
3. Avoid broad autonomous behavior outside task scope.

Expected task families:
1. Method summarization.
2. Service/step localization.
3. Failure analysis.
4. Fix drafting.
5. Evidence extraction.

### Maintainer Agent (Non-Runtime, Project Development)

MUST be treated as external to production request handling.  
Purpose:
1. Help evolve this repository (docs, contracts, skills, prompts, tooling).
2. Consume "important findings" captured from runtime sessions.
3. Improve maintainability and future release quality.

## Skills and Context Packs

Belz-AI MUST treat skills as first-class system assets.

Required skill/context domains:
1. Belzabar/NSM domain context.
2. AD and AD-CLI capability context.
3. Agent behavior and output expectations.
4. Task-specific worker instructions.

Quality rules:
1. Skills MUST be concise and composable.
2. Skills MUST include success/failure criteria.
3. Skills SHOULD avoid unnecessary token-heavy context.
4. Skill versions MUST be trackable.

## Runtime Architecture Requirements

### Web App

MUST:
1. Start and resume sessions.
2. Show intermediate and final results.
3. Remain decoupled from provider-specific worker internals.

### Orchestration Layer

MUST:
1. Normalize user requests.
2. Resolve AD IDs into inspect/test/execute context.
3. Execute sequential workers in v1.
4. Persist session state and evidence artifacts.

SHOULD:
1. Support future parallel worker execution without contract rewrites.

### Worker Adapter Layer

MUST:
1. Use a unified adapter interface independent of provider brand/model.
2. Validate structured worker outputs.
3. Expose provider capability metadata.

## ACP Alignment Strategy

1. Internal abstraction MUST be ACP-shaped to keep integrations portable.
2. v1 SHOULD prioritize stdio-based integrations for reliability.
3. Providers without native ACP MAY use shim adapters.
4. Migration to native ACP support MUST NOT break upstream orchestration contracts.

## State and Artifact Model

Each session MUST persist:
1. `state.json` (machine state).
2. `summary.md` (human-readable context snapshot).
3. `artifacts/` (worker outputs, command evidence, trace fragments).

When a high-value novel finding is observed, runtime SHOULD append an explicit maintainer finding record for later repository improvements.

## Security and Data Policy

### v1 Decision

1. No-redaction mode.
2. Manual deletion.
3. Single-user trusted-environment assumption.

### Forward Requirement

Before broader team rollout:
1. Policy modes (redaction/retention) MUST be introduced.
2. Security defaults MUST become stricter.
3. Session-level data policy metadata MUST be explicit.

## Required v1 Output Contract

Every successful diagnosis response MUST include:

1. Issue summary.
2. Suspected failing step/service.
3. Root-cause hypothesis.
4. Proposed fix plan.
5. Confidence level.
6. Supporting evidence.
7. Verification steps.
8. Explicit assumptions.

## Requirement Evolution by Version

### v1

1. AD-focused diagnosis.
2. Flexible intake.
3. Sequential delegation.
4. Stable schemas and persistent session state.

### v1.x

1. Improved confidence calibration and worker specialization.
2. Better policy modes and observability.
3. Stronger adapter capability negotiation.

### v2

1. Parallel workers.
2. Multi-module workflows (AD + PD + external systems).
3. Multi-user governance and stricter security defaults.

## Non-Goals (Current)

1. Fully autonomous production changes without user approval.
2. Automatic migrations across environments in v1 runtime path.
3. Ticketing/dev-note automation in v1 runtime path.

## Governance

1. AIM is the architecture charter.
2. ROADMAP is the sequencing and gate charter.
3. Every rolling-release increment MUST update affected docs/contracts.
