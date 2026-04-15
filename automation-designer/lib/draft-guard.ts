// Draft-safety guard.
//
// Every AD write command routes its target UUID through resolveDraftTarget()
// before any save or publish. The invariant is documented in
// expertly.coding.agents/Claude/Common/claude/skills/ad/reference/draft-publish-lifecycle.md
// and summarised in docs/api-notes.md. In short: never POST a save payload
// whose UUID resolves to a PUBLISHED method. The server will silently
// overwrite production if you do.
//
// This module is the ONLY place a write command may locate its save target.
// Write commands MUST call resolveDraftTarget() at the top of their execute()
// and refuse to proceed on a non-ok result.

import { adApi } from "./api/index";
import type { ApiVersion } from "./api-version";
import { DEFAULT_VERSION } from "./api-version";
import type { HydratedMethod, MethodState } from "./types/common";

export type DraftGuardResult =
  | {
      ok: true;
      draft: HydratedMethod;
      publishedUuid: string | null;
      switchedFromPublished: false;
    }
  | {
      ok: true;
      draft: HydratedMethod;
      publishedUuid: string;
      switchedFromPublished: true;
    }
  | {
      ok: false;
      reason: "PUBLISHED_NO_DRAFT";
      publishedUuid: string;
      message: string;
    }
  | {
      ok: false;
      reason: "REFERENCE_NOT_DRAFT";
      resolvedState: MethodState;
      publishedUuid: string;
      message: string;
    };

export interface ResolveDraftTargetDeps {
  fetchMethod: (uuid: string) => Promise<HydratedMethod>;
}

function defaultDeps(version: ApiVersion): ResolveDraftTargetDeps {
  return {
    fetchMethod: (uuid: string) => adApi.fetchMethod(uuid, version),
  };
}

/**
 * Given any AD method UUID, return the DRAFT that is safe to write to.
 *
 * Decision matrix (source: draft-publish-lifecycle.md §"Detecting Draft vs Published"):
 *   state=DRAFT, referenceId=null            → ok (new draft, never published)
 *   state=DRAFT, referenceId=<published>     → ok (draft linked to a published version)
 *   state=PUBLISHED, referenceId=<draft>     → switch to the linked draft
 *   state=PUBLISHED, referenceId=null        → abort (no draft exists; user must create one in UI)
 *
 * The second fetch path — when we switch from PUBLISHED to its linked DRAFT —
 * is tolerant of server inconsistencies: if the linked UUID itself resolves
 * to a non-DRAFT, we surface REFERENCE_NOT_DRAFT rather than proceeding.
 *
 * Accepts an injectable deps object for unit testing without network.
 */
export async function resolveDraftTarget(
  inputUuid: string,
  version: ApiVersion = DEFAULT_VERSION.fetch,
  deps: ResolveDraftTargetDeps = defaultDeps(version),
): Promise<DraftGuardResult> {
  const initial = await deps.fetchMethod(inputUuid);
  const state = initial.state;
  const referenceId = (initial.referenceId ?? "").trim() || null;

  if (state === "DRAFT") {
    return {
      ok: true,
      draft: initial,
      publishedUuid: referenceId,
      switchedFromPublished: false,
    };
  }

  // state === "PUBLISHED"
  if (!referenceId) {
    return {
      ok: false,
      reason: "PUBLISHED_NO_DRAFT",
      publishedUuid: initial.uuid,
      message:
        `Method ${initial.uuid} is PUBLISHED and has no linked draft. ` +
        `Create a draft in the AD UI (open the method, click "Save as Draft") before saving from belz.`,
    };
  }

  const linked = await deps.fetchMethod(referenceId);
  if (linked.state !== "DRAFT") {
    return {
      ok: false,
      reason: "REFERENCE_NOT_DRAFT",
      resolvedState: linked.state,
      publishedUuid: initial.uuid,
      message:
        `Method ${initial.uuid} is PUBLISHED; its referenceId ${referenceId} resolved to state=${linked.state} ` +
        `instead of DRAFT. Refusing to save. Re-fetch the method in belz and check state manually.`,
    };
  }

  return {
    ok: true,
    draft: linked,
    publishedUuid: initial.uuid,
    switchedFromPublished: true,
  };
}
