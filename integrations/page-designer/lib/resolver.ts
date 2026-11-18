// Input resolution for read commands: app URL, PD designer URL, bare id, or a
// page/component name → the fetched page body.
//
// The entity type is the SERVER's (parser `inferEntityType`: `isComponent`,
// `pageType`, route), never guessed from the input shape. A
// name resolves to the one DRAFT component with that exact name, else the one
// DRAFT page with that name; several matches are PD_NAME_AMBIGUOUS —
// names are not unique.
//
// `version` picks the copy: when the resolved row is not the one asked for,
// its `referenceId` sibling is read (never paired by name). Every result says
// which copy was read (`resolvedAs`). Ids are env-local: with `nameFromEnv`,
// an id missing on the active env is looked up there and its NAME is
// resolved on the active env instead.

import { CliError, Config, strOrNull } from "@belzabar/core";
import { pdApi } from "./api/index";
import { isComponentRow } from "./api/client";
import { cachedFetchPageConfigSwr, type ConfigSource, type SwrConfigResult } from "./cache";
import { inferEntityType } from "./parser/index";
import { parsePdUrl, tryParseUrl } from "./url-parser";
import type { RawPageResponse } from "./types/wire";
import { isHex32 } from "@belzabar/core/platform";

export type InputKind = "app-url" | "pd-url" | "id" | "name";

/** Which copy of a page to read: the draft or the published row. */
export type PdCopy = "draft" | "published";

export interface ResolveOptions {
  /** Read this copy, following `referenceId` when the input resolves to the other one. */
  version?: PdCopy | null;
  /** Env to look an id up in (for its name) when the id is not on the active env. */
  nameFromEnv?: string | null;
}

export interface ResolvedEntity {
  entityType: "PAGE" | "COMPONENT";
  resolvedId: string;
  response: RawPageResponse;
  inputKind: InputKind;
  source: ConfigSource;
  /** Status of the row that was read: DRAFT or PUBLISHED (DELETED for a soft-deleted id). */
  resolvedAs: string;
  /** Set when `version` followed `referenceId`: the id the input resolved to first. */
  switchedFrom?: string;
  /** Set when an id missing on the active env was resolved by its name from `nameFromEnv`. */
  byNameFrom?: { env: string; id: string; name: string };
}

const statusOf = (raw: RawPageResponse): string => (typeof raw.status === "string" ? raw.status.toUpperCase() : "UNKNOWN");

export interface DetectedInput {
  kind: InputKind;
  /** For pd-url: the URL's route type (page vs symbol). */
  urlType?: "PAGE" | "COMPONENT";
  pdToken?: string;
  domain?: string;
  path?: string;
}

export function detectInputKind(input: string): DetectedInput {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const pdParsed = parsePdUrl(input);
    if (pdParsed) {
      return { kind: "pd-url", urlType: pdParsed.type, pdToken: pdParsed.token };
    }

    const url = tryParseUrl(input);
    if (!url) {
      throw new CliError(`Not a valid URL: ${input}`, { code: "INVALID_URL" });
    }
    const pagesMatch = url.pathname.match(/^\/pages\/(.+)/);
    const path = pagesMatch ? pagesMatch[1]! : url.pathname.replace(/^\//, "");
    if (path) {
      return { kind: "app-url", domain: url.hostname, path };
    }

    throw new CliError(
      "Unrecognized URL format. Expected a PD designer URL (/ui-designer/page or /ui-designer/symbol) or an app page URL.",
      { code: "INVALID_URL" },
    );
  }

  if (isHex32(input)) return { kind: "id" };
  return { kind: "name" };
}

/**
 * The id for a page/component NAME: the single DRAFT component with that exact
 * name, else the single DRAFT page. `preferComponent` (a /ui-designer/symbol/
 * URL) only considers components.
 */
export async function resolveNameToId(name: string, preferComponent = false): Promise<string> {
  const rows = (await pdApi.searchPagesByName(name, "DRAFT")).filter(
    (r) => r.name === name && typeof r.id === "string",
  );
  const components = rows.filter(isComponentRow);
  const pages = rows.filter((r) => !isComponentRow(r));
  const pick = (list: typeof rows, what: string): string | null => {
    if (list.length === 0) return null;
    if (list.length > 1) {
      throw new CliError(`${list.length} ${what}s are named "${name}"; pass an id instead.`, {
        code: "PD_NAME_AMBIGUOUS",
        details: { name, ids: list.map((r) => r.id) },
      });
    }
    return list[0]!.id as string;
  };
  const id = pick(components, "component") ?? (preferComponent ? null : pick(pages, "page"));
  if (!id) {
    throw new CliError(
      preferComponent ? `Could not find component '${name}'.` : `No page or component named '${name}'.`,
      { code: "COMPONENT_NOT_FOUND", details: { name } },
    );
  }
  return id;
}

/**
 * stderr notes on how an input resolved: an id found by its name from another
 * env, a --version switch, and a NAME read as the DRAFT while a published copy
 * exists (the silent case that let a draft be compared as if it were live).
 */
export function noteResolution(r: ResolvedEntity, version: PdCopy | null | undefined, warn: (m: string) => void, where = ""): void {
  const at = where ? ` on ${where}` : "";
  if (r.byNameFrom) {
    warn(`ℹ ${r.byNameFrom.id} is not on${at || " this env"}; resolved its name "${r.byNameFrom.name}" (from ${r.byNameFrom.env}) → ${r.resolvedId}.`);
  }
  if (r.switchedFrom) warn(`ℹ --version ${version}: read ${r.resolvedId} (${r.resolvedAs}), the linked copy of ${r.switchedFrom}${at}.`);
  if (!version && r.inputKind === "name" && r.resolvedAs === "DRAFT" && strOrNull(r.response.referenceId)) {
    warn(`ℹ "${typeof r.response.name === "string" ? r.response.name : r.resolvedId}" resolved to its DRAFT${at}; pass --version published to read the published copy.`);
  }
}

/** The name of `id` on `env` (null when it is not there or `env` cannot be read). */
async function nameOnEnv(env: string, id: string): Promise<{ name: string; component: boolean } | null> {
  try {
    const raw = await Config.withEnv(env, () => pdApi.fetchPage(id));
    return raw && typeof raw.name === "string" && raw.name ? { name: raw.name, component: inferEntityType(raw) === "COMPONENT" } : null;
  } catch {
    return null;
  }
}

export async function resolveInput(input: string, force = false, opts: ResolveOptions = {}): Promise<ResolvedEntity> {
  const detected = detectInputKind(input);
  let resolvedId: string;
  let byNameFrom: ResolvedEntity["byNameFrom"];

  switch (detected.kind) {
    case "app-url": {
      const refId = await pdApi.fetchDeployablePageByAppUrl(detected.domain!, detected.path!);
      if (!refId) {
        throw new CliError(
          `No deployed page found for domain '${detected.domain}' at path '${detected.path}'.`,
          { code: "PAGE_NOT_FOUND" },
        );
      }
      resolvedId = refId;
      break;
    }
    case "pd-url":
      resolvedId =
        detected.urlType === "PAGE" ? detected.pdToken! : await resolveNameToId(detected.pdToken!, true);
      break;
    case "id":
      resolvedId = input;
      break;
    case "name":
      resolvedId = await resolveNameToId(input);
      break;
  }

  // One fetch: pages and components share GET /pages/{id} (the old second
  // "component" fetch of the same URL is gone).
  let result: SwrConfigResult = await cachedFetchPageConfigSwr(resolvedId, force);
  if (!result.data && detected.kind === "id" && opts.nameFromEnv && opts.nameFromEnv !== Config.activeEnv.name) {
    // Ids are env-local: find the id's name where it came from, resolve that name here.
    const there = await nameOnEnv(opts.nameFromEnv, input);
    if (there) {
      resolvedId = await resolveNameToId(there.name, there.component).catch((err: unknown) => {
        if (!(err instanceof CliError) || err.code !== "COMPONENT_NOT_FOUND") throw err;
        throw new CliError(
          `No page or component found for ID: ${input} on ${Config.activeEnv.name}, and its name "${there.name}" (on ${opts.nameFromEnv}) is not there either.`,
          { code: "NOT_FOUND", details: { id: input, name: there.name, nameFromEnv: opts.nameFromEnv } },
        );
      });
      byNameFrom = { env: opts.nameFromEnv, id: input, name: there.name };
      result = await cachedFetchPageConfigSwr(resolvedId, force);
    }
  }
  if (!result.data) {
    throw new CliError(
      detected.kind === "id"
        ? `No page or component found for ID: ${input} on ${Config.activeEnv.name}. Ids are env-local: pass the page or component name to resolve it on this env.`
        : `Page or component ${resolvedId} not found.`,
      { code: detected.kind === "id" ? "NOT_FOUND" : "PD_FETCH_FAILED" },
    );
  }

  let response = result.data;
  let source = result.source;
  let switchedFrom: string | undefined;
  const want = opts.version === "published" ? "PUBLISHED" : opts.version === "draft" ? "DRAFT" : null;
  if (want && statusOf(response) !== want) {
    // The other copy is the row's referenceId sibling, and it must not link elsewhere.
    const ref = strOrNull(response.referenceId);
    const sibling = ref && ref !== resolvedId ? await cachedFetchPageConfigSwr(ref, force) : null;
    const sib = sibling?.data ?? null;
    const backRef = sib ? strOrNull(sib.referenceId) : null;
    if (!sib || statusOf(sib) !== want || (backRef !== null && backRef !== resolvedId)) {
      const name = typeof response.name === "string" && response.name ? response.name : resolvedId;
      throw new CliError(
        `${name} (${resolvedId}, ${statusOf(response)}) has no ${want} copy` +
          (sib ? ` (its linked row ${ref} is ${statusOf(sib)})` : "") + ".",
        { code: "PD_VERSION_NOT_FOUND", details: { resolvedId, status: statusOf(response), referenceId: ref, wanted: want } },
      );
    }
    switchedFrom = resolvedId;
    resolvedId = ref!;
    response = sib;
    source = sibling!.source;
  }

  return {
    entityType: inferEntityType(response),
    resolvedId,
    response,
    inputKind: detected.kind,
    source,
    resolvedAs: statusOf(response),
    ...(switchedFrom ? { switchedFrom } : {}),
    ...(byNameFrom ? { byNameFrom } : {}),
  };
}
