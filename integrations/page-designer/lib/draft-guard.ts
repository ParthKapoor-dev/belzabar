// Draft-guard. Every PD write command routes through resolveDraftTarget before
// touching the server, so no mutation ever lands on a PUBLISHED page without
// explicit operator intent.
//
// Algorithm (mirrors AD's lib/draft-guard.ts): the draft/published pair is
// linked by each row's `referenceId`. Names are NOT unique (sems-dev has two
// "Add Student" pages), so the sibling is never looked up by name.
//   1. Fetch the input id. Missing/unknown status → refuse (fail closed).
//   2. DRAFT → write target is the input. Its referenceId (if any) is the
//      published sibling, confirmed by fetching it.
//   3. PUBLISHED → follow referenceId to the linked DRAFT. No link → refuse
//      (caller can pass --allow-published). A link that resolves to a non-DRAFT,
//      a missing row, or a row whose back-link points elsewhere → refuse.

import { CliError } from "@belzabar/core";
import { pdApi } from "./api/index";
import { parsePage } from "./parser/index";
import type { HydratedPage, PdEntityType, PdStatus } from "./types/common";
import type { RawPageResponse } from "./types/wire";

export interface DraftGuardDeps {
  fetchPage(id: string): Promise<RawPageResponse | null>;
}

const defaultDeps: DraftGuardDeps = {
  fetchPage: (id) => pdApi.fetchPage(id),
};

export type LinkFailureReason =
  | "UNKNOWN_STATUS"
  | "LINK_NOT_FOUND"
  | "LINK_WRONG_STATUS"
  | "LINK_MISMATCH";

export type LinkedPairResult =
  | {
      ok: true;
      draftId: string | null;
      publishedId: string | null;
      /** The DRAFT row's raw response (the input itself when it is a draft). */
      draftRaw: RawPageResponse | null;
    }
  | { ok: false; reason: LinkFailureReason; message: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function statusOf(raw: RawPageResponse): PdStatus | null {
  const s = typeof raw.status === "string" ? raw.status.toUpperCase() : "";
  return s === "DRAFT" || s === "PUBLISHED" ? s : null;
}

/**
 * Resolve the draft/published pair for an already-fetched row by following
 * its `referenceId`, and confirm the linked row points back (or at least does
 * not point elsewhere). Never guesses by name.
 */
export async function resolveLinkedPair(
  raw: RawPageResponse,
  deps: DraftGuardDeps = defaultDeps,
): Promise<LinkedPairResult> {
  const ownId = str(raw.id) ?? "";
  const status = statusOf(raw);
  if (!status) {
    return {
      ok: false,
      reason: "UNKNOWN_STATUS",
      message: `Page ${ownId} has no recognisable status (${String(raw.status)}); refusing to guess draft vs published.`,
    };
  }
  const refId = str(raw.referenceId);
  const expected: PdStatus = status === "DRAFT" ? "PUBLISHED" : "DRAFT";

  if (!refId || refId === ownId) {
    return status === "DRAFT"
      ? { ok: true, draftId: ownId, publishedId: null, draftRaw: raw }
      : { ok: true, draftId: null, publishedId: ownId, draftRaw: null };
  }

  const linked = await deps.fetchPage(refId);
  if (!linked) {
    return {
      ok: false,
      reason: "LINK_NOT_FOUND",
      message: `Page ${ownId} (${status}) links to ${refId} via referenceId, but ${refId} was not found.`,
    };
  }
  const linkedStatus = statusOf(linked);
  if (linkedStatus !== expected) {
    return {
      ok: false,
      reason: "LINK_WRONG_STATUS",
      message:
        `Page ${ownId} (${status}) links to ${refId}, which is ${String(linked.status)} ` +
        `instead of ${expected}. Refusing to guess the sibling.`,
    };
  }
  const backRef = str(linked.referenceId);
  if (backRef && backRef !== ownId) {
    return {
      ok: false,
      reason: "LINK_MISMATCH",
      message:
        `Page ${ownId} links to ${refId}, but ${refId} links back to ${backRef}. ` +
        `The draft/published pair is ambiguous; refusing.`,
    };
  }
  return status === "DRAFT"
    ? { ok: true, draftId: ownId, publishedId: refId, draftRaw: raw }
    : { ok: true, draftId: refId, publishedId: ownId, draftRaw: linked };
}

export type DraftGuardResult =
  | {
      ok: true;
      draft: HydratedPage;
      draftId: string;
      publishedId: string | null;
      switchedFromPublished: boolean;
    }
  | {
      ok: false;
      reason: "PUBLISHED_NO_DRAFT";
      publishedId: string;
      name: string;
      entityType: PdEntityType;
    }
  | {
      ok: false;
      reason: LinkFailureReason;
      publishedId: string | null;
      inputId: string;
      message: string;
    }
  | {
      ok: false;
      reason: "NOT_FOUND";
      inputId: string;
    };

export async function resolveDraftTarget(
  inputId: string,
  deps: DraftGuardDeps = defaultDeps,
): Promise<DraftGuardResult> {
  const raw = await deps.fetchPage(inputId);
  if (!raw) return { ok: false, reason: "NOT_FOUND", inputId };

  const link = await resolveLinkedPair(raw, deps);
  if (!link.ok) {
    return {
      ok: false,
      reason: link.reason,
      publishedId: statusOf(raw) === "PUBLISHED" ? str(raw.id) : null,
      inputId,
      message: link.message,
    };
  }

  const page = parsePage(raw);
  if (!link.draftId || !link.draftRaw) {
    return {
      ok: false,
      reason: "PUBLISHED_NO_DRAFT",
      publishedId: page.id,
      name: page.name,
      entityType: page.entityType,
    };
  }

  const switched = link.draftRaw !== raw;
  return {
    ok: true,
    draft: switched ? parsePage(link.draftRaw) : page,
    draftId: link.draftId,
    publishedId: link.publishedId,
    switchedFromPublished: switched,
  };
}

export function describeDraftGuardFailure(result: DraftGuardResult & { ok: false }): CliError {
  if (result.reason === "NOT_FOUND") {
    return new CliError(`Page ${result.inputId} not found on this environment.`, {
      code: "PD_NOT_FOUND",
    });
  }
  if (result.reason === "PUBLISHED_NO_DRAFT") {
    return new CliError(
      `Page "${result.name}" is PUBLISHED with no linked DRAFT (${result.publishedId}). ` +
        `Refusing to write directly to a published page. Pass --allow-published to override.`,
      {
        code: "PD_PUBLISHED_NO_DRAFT",
        details: { publishedId: result.publishedId, entityType: result.entityType },
      },
    );
  }
  return new CliError(result.message, {
    code: "PD_DRAFT_LINK_UNRESOLVED",
    details: { inputId: result.inputId, reason: result.reason },
  });
}

export type { PdEntityType, PdStatus };
