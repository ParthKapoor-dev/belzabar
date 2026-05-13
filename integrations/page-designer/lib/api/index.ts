// pdApi — the façade every PD command must import from.
//
// Internally delegates to lib/api/client.ts for the raw HTTP calls. Commands
// never import from client.ts directly. Writes go through withLock (see
// lib/lock.ts) at the caller — the façade does not lock automatically, because
// some flows need to batch multiple PUTs inside a single lock window.

import * as client from "./client";
import type {
  RawPageResponse,
  RawPageListItem,
  RawHistoryEntry,
  RawPartialUpdateOperation,
  PdStatus,
  PdEntityType,
} from "../types/wire";
import type { SaveResult } from "./client";

export type { SaveResult };
export type { RawPageListItem };

// Legacy call-site shims — re-exported so existing commands + lib files keep
// compiling without reaching into client.ts directly.
export const fetchPageConfig = client.fetchPage;
export const fetchComponentConfig = client.fetchPage;
export const fetchComponentIdByName = client.fetchComponentIdByName;
export const fetchAllPages = client.fetchAllPages;
export const fetchAllComponents = client.fetchAllComponents;
export const fetchDeployablePageByAppUrl = client.fetchDeployablePageByAppUrl;
export const searchPagesByName = client.searchPagesByName;

export const pdApi = {
  // -------- reads ---------------------------------------------------------
  fetchPage(pageId: string): Promise<RawPageResponse | null> {
    return client.fetchPage(pageId);
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

  releaseLock(pageId: string): Promise<void> {
    return client.releaseLock(pageId);
  },
};

// Helper used by draft-guard to resolve siblings by name.
export async function fetchEntityIdsByName(
  name: string,
  entityType: PdEntityType,
): Promise<{ draftId: string | null; publishedId: string | null }> {
  const [draftItems, publishedItems] = await Promise.all([
    client.searchPagesByName(name, "DRAFT"),
    client.searchPagesByName(name, "PUBLISHED"),
  ]);

  const expectSymbol = entityType === "COMPONENT";

  const infer = (item: RawPageListItem): boolean | null => {
    if (typeof item.isSymbol === "boolean") return item.isSymbol;
    const layout = item.layout as { isSymbol?: unknown } | undefined;
    if (layout && typeof layout.isSymbol === "boolean") return layout.isSymbol;
    const nested = item.pageElement as { layout?: { isSymbol?: unknown } } | undefined;
    if (nested?.layout && typeof nested.layout.isSymbol === "boolean") {
      return nested.layout.isSymbol;
    }
    return null;
  };
  const pick = (items: RawPageListItem[]): RawPageListItem | null => {
    if (items.length === 0) return null;
    const strict = items.find((i) => infer(i) === expectSymbol);
    return strict ?? items[0] ?? null;
  };

  const draft = pick(draftItems);
  const published = pick(publishedItems);

  return {
    draftId: typeof draft?.id === "string" ? draft.id : null,
    publishedId: typeof published?.id === "string" ? published.id : null,
  };
}
