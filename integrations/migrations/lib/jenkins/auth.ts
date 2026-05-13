import { CliError } from "@belzabar/core";

export interface JenkinsAuth {
  baseUrl: string;
  user: string;
  password: string;
  job: string;
}

export function buildHeaders(auth: JenkinsAuth, extra: Record<string, string> = {}): Record<string, string> {
  const basic = `Basic ${btoa(`${auth.user}:${auth.password}`)}`;
  return {
    Authorization: basic,
    Accept: "application/json",
    ...extra,
  };
}

export function assertJenkinsAuth(auth: { baseUrl?: string; user?: string; password?: string; migrationJob?: string }): JenkinsAuth {
  const missing: string[] = [];
  if (!auth.baseUrl) missing.push("baseUrl");
  if (!auth.user) missing.push("user");
  if (!auth.password) missing.push("password");
  if (missing.length > 0) {
    throw new CliError(
      `Jenkins configuration missing: ${missing.join(", ")}. Set them in ~/.belz/config.json under "jenkins" or via BELZ_JENKINS_URL/USER/PASSWORD env vars.`,
      { code: "MIGRATE_JENKINS_CONFIG_MISSING", details: { missing } }
    );
  }
  return {
    baseUrl: (auth.baseUrl as string).replace(/\/$/, ""),
    user: auth.user as string,
    password: auth.password as string,
    job: auth.migrationJob || "expertly.db-migration",
  };
}
