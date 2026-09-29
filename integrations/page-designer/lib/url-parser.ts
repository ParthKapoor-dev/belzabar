import { CliError } from "@belzabar/core";

type PdEntityType = "PAGE" | "COMPONENT";

interface ParsedPdUrl {
  type: PdEntityType;
  token: string;
  host: string;
  path: string;
}

const PD_URL_PATTERN = /^\/ui-designer\/(page|symbol)\/([^/?#]+)/i;

/** Parse a URL, or null when it is not a valid absolute URL. */
export function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/**
 * A PD designer URL (`/ui-designer/page/<id>` or `/ui-designer/symbol/<name>`),
 * or null when `input` is not one. A malformed %-escape in the token is an
 * INVALID_URL CliError (PD-17), not an unhandled URIError.
 */
export function parsePdUrl(input: string): ParsedPdUrl | null {
  if (!input) return null;
  const parsed = tryParseUrl(input);
  if (!parsed) return null;

  const match = parsed.pathname.match(PD_URL_PATTERN);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const route = match[1].toLowerCase();
  let token: string;
  try {
    token = decodeURIComponent(match[2]);
  } catch {
    throw new CliError(`Malformed escape sequence in PD URL: ${input}`, { code: "INVALID_URL" });
  }

  return {
    type: route === "page" ? "PAGE" : "COMPONENT",
    token,
    host: parsed.host,
    path: parsed.pathname,
  };
}
