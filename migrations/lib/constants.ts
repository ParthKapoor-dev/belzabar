import { join } from "path";
import { BELZ_CONFIG_DIR } from "@belzabar/core";

export const DEFAULT_JENKINS_BASE_URL = "https://jenkins-asg.stg.expertly.cloud";
export const DEFAULT_JENKINS_JOB = "expertly.db-migration";

export const MIGRATION_PROFILES_CACHE_PATH = join(BELZ_CONFIG_DIR, "migrations", "jenkins-profiles.json");

export const JENKINS_CLIENTS = [
  "SEMS",
  "Exp AI",
  "YS (YieldSec)",
  "TH (TownHouse)",
  "NCDNS (NSS)",
  "DNREC",
  "AHS (NC AHS)",
  "Core/Other",
] as const;

export type JenkinsClient = (typeof JENKINS_CLIENTS)[number];

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

export const ENV_TO_PROFILE_SEGMENT: Record<string, string> = {
  "nsm-dev": "devncdns",
  "nsm-qa": "qancdns",
  "nsm-uat": "uatncdns",
  "nsm-stage": "stgncdns",
  "nsm-stage2": "stg2ncdns",
};

export const QUEUE_POLL_INTERVAL_MS = 2000;
export const CONSOLE_POLL_INTERVAL_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
