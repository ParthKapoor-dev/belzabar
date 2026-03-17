export type ParseResult = {
  host: string
  uuid: string
  body: Record<string, unknown>
  targetUrl: string
}

export function parseCurl(raw: string): { result: ParseResult | null; error: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { result: null, error: null }

  // Extract URL — try curl-specific pattern first, fall back to first https URL
  let rawUrl: string | undefined
  const curlUrlMatch = trimmed.match(/curl\s+(?:'[^']*'|-[^\s]+\s+)*['"]?(https?:\/\/[^\s'"\\]+)['"]?/)
  if (curlUrlMatch) {
    rawUrl = curlUrlMatch[1]
  } else {
    rawUrl = trimmed.match(/https?:\/\/[^\s'"\\]+/)?.[0]
  }
  if (!rawUrl) return { result: null, error: "Could not find a URL in the curl command" }

  let host: string
  try {
    host = new URL(rawUrl).host
  } catch {
    return { result: null, error: "Invalid URL in curl command" }
  }

  // Extract UUID from /execute/<uuid>
  const uuidMatch = rawUrl.match(/\/execute\/([a-f0-9]{8,}[a-f0-9]*)/)
  if (!uuidMatch) return { result: null, error: "Could not find execution UUID in URL (expected /execute/<uuid>)" }
  const uuid = uuidMatch[1]

  // Extract JSON body — handle --data-raw, --data, -d with single/double quotes and bash $'...'
  const bodyPatterns = [
    /(?:--data(?:-raw)?|-d)\s+\$'([\s\S]*?)'\s*(?=\\?\n|$)/,
    /(?:--data(?:-raw)?|-d)\s+'([\s\S]*?)'\s*(?=\\?\n|$)/,
    /(?:--data(?:-raw)?|-d)\s+"([\s\S]*?)"\s*(?=\\?\n|$)/,
    /(?:--data(?:-raw)?|-d)\s+'([\s\S]*?)'/,
    /(?:--data(?:-raw)?|-d)\s+"([\s\S]*?)"/,
  ]

  let bodyRaw: string | null = null
  for (const pattern of bodyPatterns) {
    const m = trimmed.match(pattern)
    if (m) { bodyRaw = m[1]; break }
  }

  if (!bodyRaw) return { result: null, error: "Could not find JSON body (--data-raw or -d)" }

  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(bodyRaw)
    if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
      return { result: null, error: "Request body is not a JSON object" }
    }
    body = parsed
  } catch {
    return { result: null, error: "Request body is not valid JSON" }
  }

  const encoded = btoa(JSON.stringify(body))
  const targetUrl = `https://${host}/automation-designer/NSM.Staff/${uuid}?_belz_autofill=${encoded}`

  return { result: { host, uuid, body, targetUrl }, error: null }
}
