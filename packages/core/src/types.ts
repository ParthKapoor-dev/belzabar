export interface Environment {
  name: string;
  project: string;
  baseUrl: string;
  credentials: {
    loginId: string;
    passwordEncoded: string;
  };
}

export interface AuthSession {
  token: string;
  refreshToken: string;
}

export interface ApiOptions extends RequestInit {
  authMode?: "Bearer" | "Raw" | "None";
}
