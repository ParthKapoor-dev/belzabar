// Input resolution for read commands: app URL, PD designer URL, bare id, or a
// page/component name → the fetched page body.
//
// The entity type is the SERVER's (parser `inferEntityType`: `isComponent`,
// `pageType`, route), never guessed from the input shape (PD-10 / F17). A
// name resolves to the one DRAFT component with that exact name, else the one
// DRAFT page with that name (PD-28); several matches are PD_NAME_AMBIGUOUS —
// names are not unique (PD-1).

import { CliError } from "@belzabar/core";
import { pdApi } from "./api/index";
import { isComponentRow } from "./api/client";
import { cachedFetchPageConfigSwr, type ConfigSource, type SwrConfigResult } from "./cache";
import { inferEntityType } from "./parser/index";
import { parsePdUrl, tryParseUrl } from "./url-parser";
import type { RawPageResponse } from "./types/wire";

export type InputKind = "app-url" | "pd-url" | "id" | "name";

export interface ResolvedEntity {
  entityType: "PAGE" | "COMPONENT";
  resolvedId: string;
  response: RawPageResponse;
  inputKind: InputKind;
  source: ConfigSource;
}

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

  if (/^[0-9a-f]{32}$/i.test(input)) return { kind: "id" };
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

export async function resolveInput(input: string, force = false): Promise<ResolvedEntity> {
  const detected = detectInputKind(input);
  let resolvedId: string;

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
  const result: SwrConfigResult = await cachedFetchPageConfigSwr(resolvedId, force);
  if (!result.data) {
    throw new CliError(
      detected.kind === "id" ? `No page or component found for ID: ${input}` : `Page or component ${resolvedId} not found.`,
      { code: detected.kind === "id" ? "NOT_FOUND" : "PD_FETCH_FAILED" },
    );
  }

  return {
    entityType: inferEntityType(result.data),
    resolvedId,
    response: result.data,
    inputKind: detected.kind,
    source: result.source,
  };
}
