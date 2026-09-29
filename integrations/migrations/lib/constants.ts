import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";

export const MIGRATION_PROFILES_CACHE_PATH = join(BELZ_CONFIG_DIR, "migrations", "jenkins-profiles.json");

/**
 * A Jenkins client group: the name of a `--- <client> ---` divider in the job's
 * PROFILE_NAME choices. Discovered from Jenkins, never hard-coded.
 */
export type JenkinsClient = string;

export const KNOWN_MIGRATE_TYPES = [
  "AD_Method",
  "PD",
  "AD_COMPARISON_REPORT",
  "PD_COMPARISON_REPORT",
  "AD_MIGRATION_STATUS",
  "PD_MIGRATION_STATUS",
  "AD_Service",
] as const;

export type MigrateType = (typeof KNOWN_MIGRATE_TYPES)[number];
