export interface ParsedError {
  summary: string;
  detail: string;
  type: 'DB' | 'CODE' | 'UNKNOWN';
}

export class ErrorParser {
  static parse(stepStatus: any): ParsedError {
    if (!stepStatus || !stepStatus.message) {
      return {
        summary: "Unknown Error",
        detail: "No error message provided.",
        type: 'UNKNOWN'
      };
    }

    const rawMessage = stepStatus.message;

    try {
      // Attempt to parse nested JSON message
      const json = JSON.parse(rawMessage);
      
      // Check for common error patterns
      // Priority 1: Database Error
      if (json.result?.databaseError) {
        return {
          summary: "Database Error",
          detail: json.result.databaseError,
          type: 'DB'
        };
      }

      // Priority 2: Standard Message
      if (json.result?.message) {
        return {
          summary: json.result.message,
          detail: json.result.stackTrace || JSON.stringify(json.result, null, 2),
          type: 'CODE'
        };
      }
      
      // Priority 3: Stack Trace Only
      if (json.stackTrace) {
        return {
          summary: "Execution Error",
          detail: json.stackTrace,
          type: 'CODE'
        };
      }

      // Fallback for valid JSON but unknown structure
      return {
        summary: "Error (Structured)",
        detail: JSON.stringify(json, null, 2),
        type: 'UNKNOWN'
      };

    } catch (e) {
      // If not JSON, return as is
      return {
        summary: "Execution Error",
        detail: rawMessage,
        type: 'UNKNOWN'
      };
    }
  }
}
