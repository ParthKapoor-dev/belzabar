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
import * as changelog from "./changelog";
import { CacheManager } from "../cache";
import { Config } from "@belzabar/core";
import { buildServiceResolver } from "../hydrator";
import { parseV1Method } from "../parser/v1";
import { parseV2Method } from "../parser/v2";

export type {
  SaveMethodResult as V1SaveMethodResult,
  MethodVersionSummary,
  MethodVersionFull,
} from "./v1";
export type { V2TestExecuteResult } from "./v2";
export type { ChangelogEntry } from "./changelog";

export const adApi = {
  // ─── Reads ───────────────────────────────────────────────────────────

  /**
   * Fetch + parse, with steps classified by service identity (AD-02): V1
   * steps are resolved through the env-scoped definition cache, V2 steps by
   * their wire `serviceName`/`methodName`. `uuid` should already be canonical
   * (lib/ids.ts:resolveMethodRef).
   */
  async fetchMethod(uuid: string, version: ApiVersion): Promise<HydratedMethod> {
    const env = Config.activeEnv.name;
    if (version === "v2") return parseV2Method(await v2.fetchRawMethod(uuid), { env });
    const raw = await v1.fetchRawMethod(uuid);
    const { resolveService, unresolved } = await buildServiceResolver(raw);
    const method = parseV1Method(raw, { env, resolveService });
    if (unresolved.length > 0) {
      method.parseWarnings.push(
        `Service definition lookup failed for automationId(s) ${unresolved.join(", ")}; those steps are classified ` +
          "by the verified fast path only and may show as EXISTING_SERVICE.",
      );
    }
    return method;
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

  async getTestSuiteReport(): Promise<unknown> {
    return v1.getTestSuiteReport();
  },

  // ─── Writes ──────────────────────────────────────────────────────────

  // Writes invalidate the local method cache for every uuid they touch, so a
  // following `ad show` never serves the pre-write body (AD-06).
  async saveMethod(payload: V1SavePayload): Promise<v1.SaveMethodResult> {
    try {
      const saved = await v1.saveMethod(payload);
      await CacheManager.invalidate(saved.method?.uuid);
      return saved;
    } finally {
      await CacheManager.invalidate(payload.uuid);
    }
  },

  async publishDraft(draftUuid: string): Promise<{ publishedUuid: string }> {
    try {
      const result = await v1.publishDraft(draftUuid);
      await CacheManager.invalidate(result.publishedUuid);
      return result;
    } finally {
      await CacheManager.invalidate(draftUuid);
    }
  },

  // ─── Changelog ───────────────────────────────────────────────────────

  async listChangelog(chainId: number): Promise<changelog.ChangelogEntry[]> {
    return changelog.listChangelog(chainId);
  },

  async addChangelog(chainId: number, comment: string): Promise<string | null> {
    return changelog.addChangelog(chainId, comment);
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
  }): Promise<boolean | null> {
    return v1.historyRestore(opts);
  },
};
