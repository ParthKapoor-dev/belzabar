// Error parsing helpers for AD responses.
//
// AD sometimes returns HTTP 200 with a Java exception object in the body —
// this happens for compile-time failures in EXISTING_SERVICE steps. The
// detectJavaException() helper recognises that shape and extracts a useful
// message + context. The ErrorParser class remains for step-status parsing
// (inside a successful test response's per-step trace).

export interface ParsedError {
  summary: string;
  detail: string;
  type: "DB" | "CODE" | "UNKNOWN";
}

export class ErrorParser {
  static parse(stepStatus: any): ParsedError {
    if (!stepStatus || !stepStatus.message) {
      return {
        summary: "Unknown Error",
        detail: "No error message provided.",
        type: "UNKNOWN",
      };
    }

    const rawMessage = stepStatus.message;

    try {
      const json = JSON.parse(rawMessage);

      if (json.result?.databaseError) {
        return {
          summary: "Database Error",
          detail: json.result.databaseError,
          type: "DB",
        };
      }

      if (json.result?.message) {
        return {
          summary: json.result.message,
          detail: json.result.stackTrace || JSON.stringify(json.result, null, 2),
          type: "CODE",
        };
      }

      if (json.stackTrace) {
        return {
          summary: "Execution Error",
          detail: json.stackTrace,
          type: "CODE",
        };
      }

      return {
        summary: "Error (Structured)",
        detail: JSON.stringify(json, null, 2),
        type: "UNKNOWN",
      };
    } catch {
      return {
        summary: "Execution Error",
        detail: rawMessage,
        type: "UNKNOWN",
      };
    }
  }
}

export interface DetectedJavaException {
  message: string;
  causeMessage: string | null;
  /** The bad automationApiId extracted from a "Invalid Automation API Id - NNN" message, if present. */
  badAutomationApiId: string | null;
  /** Full raw body for logging. */
  raw: unknown;
}

/**
 * Detect the Java-exception body that AD returns on HTTP 200 for compile-
 * time failures in an EXISTING_SERVICE step. Shape:
 *   {
 *     message: "...",
 *     stackTrace: [...],       // array — distinguishes it from a normal result
 *     cause?: { message?, localizedMessage? }
 *     // NO services[] and NO executionStatus
 *   }
 * Returns null when the body does not match this pattern.
 */
export function detectJavaException(body: unknown): DetectedJavaException | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  if (typeof b.message !== "string") return null;
  if (!Array.isArray(b.stackTrace)) return null;
  if ("services" in b && b.services != null) return null;
  if ("executionStatus" in b && b.executionStatus != null) return null;

  const cause = (b.cause ?? null) as Record<string, unknown> | null;
  const causeMessage =
    (cause && typeof cause.message === "string" && cause.message) ||
    (cause && typeof cause.localizedMessage === "string" && (cause.localizedMessage as string)) ||
    null;

  const idMatch = causeMessage?.match(/Invalid Automation API Id - (\d+)/);
  const badAutomationApiId = idMatch ? idMatch[1]! : null;

  return {
    message: b.message,
    causeMessage,
    badAutomationApiId,
    raw: body,
  };
}
