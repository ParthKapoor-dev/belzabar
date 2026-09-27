export interface Environment {
  name: string;
  project: string;
  baseUrl: string;
  credentials: {
    loginId: string;
    /** Password in its stored form — decode with Config.password / decodeSecret. */
    password: string;
    /** Stored encoding; undefined = legacy base64. */
    passwordEncoding?: "plain" | "base64";
  };
  /** Set when the env's config entry is unusable (e.g. no url); using it throws CONFIG_INVALID. */
  problem?: string;
}

export interface AuthSession {
  token: string;
  refreshToken: string;
}

export interface ApiOptions extends RequestInit {
  authMode?: "Bearer" | "Raw" | "None";
  /**
   * Per-call timeout in ms (default 60 s for GET/HEAD, 300 s otherwise; `0` or
   * `"none"` disables — use it for long server-side runs and streams).
   */
  timeoutMs?: number | "none";
}
