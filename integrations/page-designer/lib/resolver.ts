import { CliError } from "@belzabar/core";
import {
  fetchComponentIdByName,
  fetchDeployablePageByAppUrl,
} from "./api/index";
import {
  cachedFetchPageConfigSwr,
  cachedFetchComponentConfigSwr,
  type ConfigSource,
  type SwrConfigResult,
} from "./cache";
import { parsePdUrl } from "./url-parser";
import type { RawPageResponse as PageConfigResponse } from "./types/wire";

export type InputKind = "app-url" | "pd-url" | "id" | "name";

export interface ResolvedEntity {
  entityType: "PAGE" | "COMPONENT";
  resolvedId: string;
  response: PageConfigResponse;
  inputKind: InputKind;
  source: ConfigSource;
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
  let result: SwrConfigResult;

  const fetchPage = (id: string) => cachedFetchPageConfigSwr(id, force);
  const fetchComponent = (id: string) => cachedFetchComponentConfigSwr(id, force);

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
      result = await fetchPage(resolvedId);
      break;
    }

    case "pd-url": {
      if (detected.entityType === "PAGE") {
        resolvedId = detected.pdToken!;
        result = await fetchPage(resolvedId);
      } else {
        const componentId = await fetchComponentIdByName(detected.pdToken!);
        if (!componentId) {
          throw new CliError(`Could not find ID for component '${detected.pdToken}'.`, {
            code: "COMPONENT_NOT_FOUND",
          });
        }
        resolvedId = componentId;
        result = await fetchComponent(resolvedId);
      }
      break;
    }

    case "id": {
      result = await fetchPage(input);
      if (result.data) {
        resolvedId = input;
        entityType = "PAGE";
      } else {
        result = await fetchComponent(input);
        if (!result.data) {
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
      result = await fetchComponent(resolvedId);
      break;
    }
  }

  if (!result!.data) {
    throw new CliError("Failed to fetch Page Designer configuration.", {
      code: "PD_FETCH_FAILED",
    });
  }

  return {
    entityType,
    resolvedId: resolvedId!,
    response: result!.data,
    inputKind: detected.kind,
    source: result!.source,
  };
}
