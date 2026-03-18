import { CliError } from "@belzabar/core";
import {
  fetchComponentIdByName,
  fetchDeployablePageByAppUrl,
} from "./api";
import { cachedFetchPageConfig, cachedFetchComponentConfig } from "./cache";
import { parsePdUrl } from "./url-parser";
import type { PageConfigResponse } from "./types";

export type InputKind = "app-url" | "pd-url" | "id" | "name";

export interface ResolvedEntity {
  entityType: "PAGE" | "COMPONENT";
  resolvedId: string;
  response: PageConfigResponse;
  inputKind: InputKind;
  source: "cache" | "fresh";
}

export function detectInputKind(input: string): {
  kind: InputKind;
  entityType: "PAGE" | "COMPONENT";
  pdToken?: string;
  domain?: string;
  path?: string;
} {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const pdParsed = parsePdUrl(input);
    if (pdParsed) {
      return {
        kind: "pd-url",
        entityType: pdParsed.type,
        pdToken: pdParsed.token,
      };
    }

    const url = new URL(input);
    const pagesMatch = url.pathname.match(/^\/pages\/(.+)/);
    if (pagesMatch) {
      return {
        kind: "app-url",
        entityType: "PAGE",
        domain: url.hostname,
        path: pagesMatch[1],
      };
    }

    const path = url.pathname.replace(/^\//, "");
    if (path) {
      return {
        kind: "app-url",
        entityType: "PAGE",
        domain: url.hostname,
        path,
      };
    }

    throw new CliError(
      "Unrecognized URL format. Expected a PD designer URL (/ui-designer/page or /ui-designer/symbol) or an app page URL.",
      { code: "INVALID_URL" }
    );
  }

  if (/^[0-9a-f]{32}$/i.test(input)) {
    return { kind: "id", entityType: "PAGE" };
  }

  return { kind: "name", entityType: "COMPONENT" };
}

export async function resolveInput(input: string, force = false): Promise<ResolvedEntity> {
  const detected = detectInputKind(input);
  let entityType: "PAGE" | "COMPONENT" = detected.entityType;
  let resolvedId: string;
  let response: PageConfigResponse | null;

  // Try cached first to determine source
  const fetchPage = (id: string) => cachedFetchPageConfig(id, force);
  const fetchComponent = (id: string) => cachedFetchComponentConfig(id, force);

  switch (detected.kind) {
    case "app-url": {
      const refId = await fetchDeployablePageByAppUrl(detected.domain!, detected.path!);
      if (!refId) {
        throw new CliError(
          `No deployed page found for domain '${detected.domain}' at path '${detected.path}'.`,
          { code: "PAGE_NOT_FOUND" }
        );
      }
      resolvedId = refId;
      response = await fetchPage(resolvedId);
      break;
    }

    case "pd-url": {
      if (detected.entityType === "PAGE") {
        resolvedId = detected.pdToken!;
        response = await fetchPage(resolvedId);
      } else {
        const componentId = await fetchComponentIdByName(detected.pdToken!);
        if (!componentId) {
          throw new CliError(`Could not find ID for component '${detected.pdToken}'.`, {
            code: "COMPONENT_NOT_FOUND",
          });
        }
        resolvedId = componentId;
        response = await fetchComponent(resolvedId);
      }
      break;
    }

    case "id": {
      response = await fetchPage(input);
      if (response) {
        resolvedId = input;
        entityType = "PAGE";
      } else {
        response = await fetchComponent(input);
        if (!response) {
          throw new CliError(`No page or component found for ID: ${input}`, {
            code: "NOT_FOUND",
          });
        }
        resolvedId = input;
        entityType = "COMPONENT";
      }
      break;
    }

    case "name": {
      const componentId = await fetchComponentIdByName(input);
      if (!componentId) {
        throw new CliError(`Could not find component '${input}'.`, {
          code: "COMPONENT_NOT_FOUND",
        });
      }
      resolvedId = componentId;
      response = await fetchComponent(resolvedId);
      break;
    }
  }

  if (!response) {
    throw new CliError("Failed to fetch Page Designer configuration.", {
      code: "PD_FETCH_FAILED",
    });
  }

  return {
    entityType,
    resolvedId: resolvedId!,
    response,
    inputKind: detected.kind,
    source: force ? "fresh" : "cache",
  };
}
