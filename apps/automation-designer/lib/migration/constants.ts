import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";

export const DB_MIGRATION_TOOL_BASE_URL = "https://db-migration-tool.services.stage.expertly.cloud";

export const NSM_SCRIPT_NAME = "NCDNS: Migrate Source DB to Target DB";

export const NSM_PROFILE_CACHE_PATH = join(BELZ_CONFIG_DIR, "migrations", "nsm-profiles.json");

export const NSM_PROFILE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export const NSM_FALLBACK_PROFILES = [
  "devncdns_qancdns",
  "qancdns_uatncdns",
  "uatncdns_stgncdns",
  "qancdns_stgncdns",
  "stgncdns_stg2ncdns",
] as const;

export const NSM_ENV_TO_PROFILE_SEGMENT: Record<string, string> = {
  "nsm-dev": "devncdns",
  "nsm-qa": "qancdns",
  "nsm-uat": "uatncdns",
  "nsm-stage": "stgncdns",
  "nsm-stage2": "stg2ncdns",
};
