// Unified AD API façade.
//
// Commands import ONLY from here. Verbs take an ApiVersion and dispatch to
// lib/api/v1.ts or lib/api/v2.ts internally. Verbs where V2 is not supported
// silently stay on V1 — the --v2 fallback warning is the caller's job (via
// lib/args/common.ts:emitFallbackWarning).

import type { ApiVersion } from "../api-version";
import type { HydratedMethod } from "../types/common";
import type { V1AutomationDefinition, V1RawMethodResponse, V1SavePayload } from "../types/v1-wire";
import type { V2MethodResponse } from "../types/v2-wire";
import * as v1 from "./v1";
import * as v2 from "./v2";

export type {
  SaveMethodResult as V1SaveMethodResult,
  V1TestExecuteResult,
  MethodVersionSummary,
  MethodVersionFull,
} from "./v1";
export type { V2TestExecuteResult } from "./v2";

export const adApi = {
  // ─── Reads ───────────────────────────────────────────────────────────

  async fetchMethod(uuid: string, version: ApiVersion): Promise<HydratedMethod> {
    if (version === "v2") return v2.fetchMethod(uuid);
    return v1.fetchMethod(uuid);
  },

  async fetchRawMethod(
    uuid: string,
    version: ApiVersion,
  ): Promise<V1RawMethodResponse | V2MethodResponse> {
    if (version === "v2") return v2.fetchRawMethod(uuid);
    return v1.fetchRawMethod(uuid);
  },

  async fetchAutomationDefinition(automationId: string): Promise<V1AutomationDefinition | null> {
    return v1.fetchAutomationDefinition(automationId);
  },

  async listCategories(opts?: { includeSystem?: boolean }): Promise<unknown> {
    return v1.listCategories(opts);
  },

  async listServices(opts?: { limit?: number; offset?: number }): Promise<unknown> {
    return v1.listServices(opts);
  },

  async fetchChildMethodInfo(category: string, methodName: string): Promise<unknown> {
    return v1.fetchChildMethodInfo(category, methodName);
  },

  async exportMethod(methodId: string | number): Promise<unknown> {
    return v1.exportMethod(methodId);
  },

  async exportCategory(categoryId: string | number): Promise<unknown> {
    return v1.exportCategory(categoryId);
  },

  async listTestCases(chainUuid: string): Promise<unknown> {
    return v1.listTestCases(chainUuid);
  },

  async fetchTestSuite(testSuiteId: string): Promise<unknown> {
    return v1.fetchTestSuite(testSuiteId);
  },

  async getTestSuiteReport(): Promise<unknown> {
    return v1.getTestSuiteReport();
  },

  // ─── Writes ──────────────────────────────────────────────────────────

  async saveMethod(payload: V1SavePayload): Promise<v1.SaveMethodResult> {
    return v1.saveMethod(payload);
  },

  async publishDraft(draftUuid: string): Promise<{ publishedUuid: string }> {
    return v1.publishDraft(draftUuid);
  },

  async createCategory(body: Record<string, unknown>): Promise<unknown> {
    return v1.createCategory(body);
  },

  async importMethods(payload: unknown): Promise<unknown> {
    return v1.importMethods(payload);
  },

  async createTestCase(chainUuid: string, body: unknown): Promise<unknown> {
    return v1.createTestCase(chainUuid, body);
  },

  async updateTestCase(chainUuid: string, testCaseId: string, body: unknown): Promise<unknown> {
    return v1.updateTestCase(chainUuid, testCaseId, body);
  },

  async deleteTestCase(testCaseId: string): Promise<void> {
    return v1.deleteTestCase(testCaseId);
  },

  async bulkCreateTestCases(chainUuid: string, cases: unknown[]): Promise<unknown> {
    return v1.bulkCreateTestCases(chainUuid, cases);
  },

  async runTestSuite(chainUuid: string): Promise<unknown> {
    return v1.runTestSuite(chainUuid);
  },

  async deleteTestSuite(testSuiteId: string): Promise<void> {
    return v1.deleteTestSuite(testSuiteId);
  },

  // ─── Test execute ────────────────────────────────────────────────────

  async testExecuteV1(method: HydratedMethod): Promise<v1.V1TestExecuteResult> {
    return v1.testExecuteV1(method);
  },

  async testExecuteV2(
    chainUuid: string,
    inputs: Record<string, string>,
  ): Promise<v2.V2TestExecuteResult> {
    return v2.testExecute(chainUuid, inputs);
  },

  // ─── Method History ──────────────────────────────────────────────────

  async historyListAll(
    methodUUID: string,
    opts?: { includeDraft?: boolean },
  ): Promise<v1.MethodVersionSummary[]> {
    return v1.historyListAll(methodUUID, opts);
  },

  async historyGet(opts: {
    category: string;
    methodName: string;
    version: number;
    includeDraft?: boolean;
  }): Promise<v1.MethodVersionFull> {
    return v1.historyGet(opts);
  },

  async historyRestore(opts: {
    category: string;
    methodName: string;
    version: number;
    includeDraft?: boolean;
  }): Promise<boolean> {
    return v1.historyRestore(opts);
  },
};
