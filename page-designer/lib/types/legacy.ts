// Types used by the legacy analyze / reporter / comparator stack.
//
// These remain stable because the `analyze`, `find-ad-methods`, and current
// `show` presenters consume them. The parser subsystem (new) writes into
// HydratedPage / ParsedNode; the analyzer subsystem (old) writes into
// ReportNode trees. The two can coexist — keep them apart.

export interface ComponentSearchItem {
  id: string;
  name: string;
  referenceId?: string;
  status?: string;
  isSymbol?: boolean;
  layout?: { isSymbol?: boolean };
  [key: string]: unknown;
}

// `PageConfigResponse` was the old name for a wire page body. Aliased to
// RawPageResponse so resolver + caches + pre-rewrite commands all see the
// same shape.
import type { RawPageResponse } from "./wire";
export type PageConfigResponse = RawPageResponse;

export interface ReportNode {
  type: "PAGE" | "COMPONENT";
  name: string;
  id: string;
  adIds: string[];
  children: ReportNode[];
}

export interface RogueIdInfo {
  id: string;
  foundIn: string[];
}

export interface ComplianceResult {
  isCompliant: boolean;
  rogueIds: RogueIdInfo[];
  missingIds: string[];
  commonIds: string[];
}

// The following types are consumed by the current `show` presenter. They
// stay in this module until Phase 7 rewrites show to use ParsedNode/
// PageHttpRequest/PageVariable directly.
export interface NormalizedVariable {
  name: string;
  type: string | null;
  initialValue: unknown;
}

export interface NormalizedDerived {
  name: string;
  from: string[];
  spec: string | null;
  filterFn: string | null;
  sideEffect: boolean;
}

export interface HttpCallSummary {
  index: number;
  label: string;
  adId: string | null;
  serviceUuid: string | null;
  triggers: string[];
  hasEventMeta: boolean;
  eventMetaEmpty: boolean;
  outputBindings: string[];
  inProgressVar: string | null;
  method: string | null;
}

export interface EventHandlerInfo {
  nodeId: string;
  nodeName: string;
  eventTypes: string[];
}

export interface ComponentTreeNode {
  name: string;
  id: string;
  isSymbol: boolean;
  hasEvents: boolean;
  childCount: number;
  children: ComponentTreeNode[];
}

// Legacy ValidationIssue (kept for the current `validate` command signature
// until Phase 7 rewrites it to use HydratedPage-based ValidationIssue from
// common.ts). The two shapes are intentionally identical — keep in sync.
export interface ValidationIssue {
  code: string;
  severity: "error" | "warn";
  message: string;
  nodeId?: string;
  nodeName?: string;
}
