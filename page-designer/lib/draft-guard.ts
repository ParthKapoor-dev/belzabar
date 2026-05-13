// Draft-guard. Every PD write command routes through resolveDraftTarget before
// touching the server, so no mutation ever lands on a PUBLISHED page without
// explicit operator intent.
//
// Algorithm (mirrors AD's pattern):
//   1. Fetch the input id.
//   2. If its status is DRAFT, you're done — {ok, draftId: input}.
//   3. If its status is PUBLISHED, look up the matching DRAFT sibling by name.
//      If a DRAFT exists, redirect and flag switchedFromPublished.
//      If no DRAFT exists, refuse (caller can --force to override).

import { CliError } from "@belzabar/core";
import { fetchEntityIdsByName, pdApi } from "./api/index";
import { parsePage } from "./parser/index";
import type { HydratedPage, PdEntityType, PdStatus } from "./types/common";

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
      reason: "NOT_FOUND";
      inputId: string;
    };

export async function resolveDraftTarget(inputId: string): Promise<DraftGuardResult> {
  const raw = await pdApi.fetchPage(inputId);
  if (!raw) return { ok: false, reason: "NOT_FOUND", inputId };
  const page = parsePage(raw);

  if (page.status === "DRAFT") {
    const { publishedId } = await fetchEntityIdsByName(page.name, page.entityType);
    return {
      ok: true,
      draft: page,
      draftId: page.id,
      publishedId: publishedId && publishedId !== page.id ? publishedId : null,
      switchedFromPublished: false,
    };
  }

  // status === "PUBLISHED"
  const { draftId } = await fetchEntityIdsByName(page.name, page.entityType);
  if (!draftId || draftId === page.id) {
    return {
      ok: false,
      reason: "PUBLISHED_NO_DRAFT",
      publishedId: page.id,
      name: page.name,
      entityType: page.entityType,
    };
  }

  const draftRaw = await pdApi.fetchPage(draftId);
  if (!draftRaw) {
    return {
      ok: false,
      reason: "PUBLISHED_NO_DRAFT",
      publishedId: page.id,
      name: page.name,
      entityType: page.entityType,
    };
  }

  const draft = parsePage(draftRaw);
  return {
    ok: true,
    draft,
    draftId: draft.id,
    publishedId: page.id,
    switchedFromPublished: true,
  };
}

export function describeDraftGuardFailure(result: DraftGuardResult & { ok: false }): CliError {
  if (result.reason === "NOT_FOUND") {
    return new CliError(`Page ${result.inputId} not found on this environment.`, {
      code: "PD_NOT_FOUND",
    });
  }
  return new CliError(
    `Page "${result.name}" is PUBLISHED with no matching DRAFT (${result.publishedId}). ` +
      `Refusing to write directly to a published page. Use --force to override.`,
    {
      code: "PD_PUBLISHED_NO_DRAFT",
      details: { publishedId: result.publishedId, entityType: result.entityType },
    },
  );
}

export type { PdEntityType, PdStatus };
