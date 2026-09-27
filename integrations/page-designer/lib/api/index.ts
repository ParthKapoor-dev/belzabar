// pdApi — the façade every PD command must import from.
//
// Internally delegates to lib/api/client.ts for the raw HTTP calls. Commands
// never import from client.ts directly. Writes go through withLock (see
// lib/lock.ts) at the caller — the façade does not lock automatically, because
// some flows need to batch multiple PUTs inside a single lock window.

import * as client from "./client";
import type {
  RawPageResponse,
  RawPageDependencies,
  RawPageListItem,
  RawHistoryEntry,
  RawPartialUpdateOperation,
  PdStatus,
} from "../types/wire";
import type { SaveResult } from "./client";

export type { SaveResult };
export type { RawPageListItem };


export const pdApi = {
  // -------- reads ---------------------------------------------------------
  fetchPage(pageId: string): Promise<RawPageResponse | null> {
    return client.fetchPage(pageId);
  },

  fetchComponentIdByName(name: string): Promise<string | null> {
    return client.fetchComponentIdByName(name);
  },

  searchPagesByName(name: string, status: PdStatus): Promise<RawPageListItem[]> {
    return client.searchPagesByName(name, status);
  },

  fetchDeployablePageByAppUrl(domain: string, path: string): Promise<string | null> {
    return client.fetchDeployablePageByAppUrl(domain, path);
  },

  fetchAllPages(): Promise<RawPageListItem[]> {
    return client.fetchAllPages();
  },

  fetchAllComponents(): Promise<RawPageListItem[]> {
    return client.fetchAllComponents();
  },

  fetchPageDependencies(
    publishedId: string,
    status: PdStatus = "PUBLISHED",
  ): Promise<RawPageDependencies> {
    return client.fetchPageDependencies(publishedId, status);
  },

  // -------- history -------------------------------------------------------
  historyList(pageId: string): Promise<RawHistoryEntry[]> {
    return client.historyList(pageId);
  },

  historyGet(versionId: number | string): Promise<RawPageResponse | null> {
    return client.historyGet(versionId);
  },

  historyRestore(versionId: number | string): Promise<void> {
    return client.historyRestore(versionId);
  },

  // -------- writes --------------------------------------------------------
  savePageFull(pageId: string, status: PdStatus, configuration: string): Promise<SaveResult> {
    return client.savePageFull(pageId, status, configuration);
  },

  savePagePartial(
    pageId: string,
    status: PdStatus,
    operations: RawPartialUpdateOperation[],
  ): Promise<SaveResult> {
    return client.savePagePartial(pageId, status, operations);
  },

  publishPage(
    pageId: string,
    opts?: { landingPage?: boolean; hostIds?: string[] },
  ): Promise<unknown> {
    return client.publishPage(pageId, opts);
  },

  // -------- lock ----------------------------------------------------------
  acquireLock(pageId: string): Promise<void> {
    return client.acquireLock(pageId);
  },

  releaseLock(pageId: string): Promise<boolean> {
    return client.releaseLock(pageId);
  },
};
