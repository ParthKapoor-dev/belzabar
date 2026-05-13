export type PdEntityType = "PAGE" | "COMPONENT";

export interface ParsedPdUrl {
  type: PdEntityType;
  token: string;
  host: string;
  path: string;
}

const PD_URL_PATTERN = /^\/ui-designer\/(page|symbol)\/([^/?#]+)/i;

export function parsePdUrl(input: string): ParsedPdUrl | null {
  if (!input) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  const match = parsed.pathname.match(PD_URL_PATTERN);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const route = match[1].toLowerCase();
  const token = decodeURIComponent(match[2]);

  return {
    type: route === "page" ? "PAGE" : "COMPONENT",
    token,
    host: parsed.host,
    path: parsed.pathname,
  };
}
