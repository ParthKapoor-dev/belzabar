import { z } from "zod";
import { join } from "path";
import { homedir } from "os";
import type { Environment } from "./types";

export const BELZ_CONFIG_DIR = join(homedir(), ".belz");

// Best-effort load of ~/.belz/config.json
interface BelzConfigFile {
  environments?: Record<string, {
    url?: string;
    user?: string;
    password?: string;
  }>;
}

function loadConfigFile(): BelzConfigFile {
  try {
    const configPath = join(BELZ_CONFIG_DIR, "config.json");
    // Synchronous read via Bun
    const file = Bun.file(configPath);
    // existsSync isn't available here in a sync context cleanly; use try/catch on readFileSync
    const { readFileSync } = require("fs");
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as BelzConfigFile;
  } catch {
    return {};
  }
}

const configFile = loadConfigFile();
const fileEnvs = configFile.environments ?? {};

const envSchema = z.object({
  // NSM Dev (Default)
  NSM_DEV_URL: z.string().default("https://nsm-dev.nc.verifi.dev"),
  NSM_DEV_USER: z.string().optional(),
  NSM_DEV_PASSWORD: z.string().optional(),

  // NSM QA
  NSM_QA_URL: z.string().default("https://nsm-qa.nc.verifi.dev"),
  NSM_QA_USER: z.string().optional(),
  NSM_QA_PASSWORD: z.string().optional(),

  // NSM UAT
  NSM_UAT_URL: z.string().default("https://nsm-uat.nc.verifi.dev"),
  NSM_UAT_USER: z.string().optional(),
  NSM_UAT_PASSWORD: z.string().optional(),

  // Legacy Fallback
  BASE_URL: z.string().optional(),
  API_USER: z.string().optional(),
  API_PASSWORD: z.string().optional(),
});

const processEnv = envSchema.parse(process.env);

// Config file wins over env vars for per-environment values
const getCreds = (
  fileUser: string | undefined,
  filePass: string | undefined,
  specificUser?: string,
  specificPass?: string
) => {
  return {
    loginId: fileUser ?? specificUser ?? processEnv.API_USER ?? "",
    passwordEncoded: filePass ?? specificPass ?? processEnv.API_PASSWORD ?? "",
  };
};

const environments: Record<string, Environment> = {
  "nsm-dev": {
    name: "nsm-dev",
    project: "NSM",
    baseUrl: fileEnvs["nsm-dev"]?.url ?? processEnv.NSM_DEV_URL,
    credentials: getCreds(
      fileEnvs["nsm-dev"]?.user,
      fileEnvs["nsm-dev"]?.password,
      processEnv.NSM_DEV_USER,
      processEnv.NSM_DEV_PASSWORD
    ),
  },
  "nsm-qa": {
    name: "nsm-qa",
    project: "NSM",
    baseUrl: fileEnvs["nsm-qa"]?.url ?? processEnv.NSM_QA_URL,
    credentials: getCreds(
      fileEnvs["nsm-qa"]?.user,
      fileEnvs["nsm-qa"]?.password,
      processEnv.NSM_QA_USER,
      processEnv.NSM_QA_PASSWORD
    ),
  },
  "nsm-uat": {
    name: "nsm-uat",
    project: "NSM",
    baseUrl: fileEnvs["nsm-uat"]?.url ?? processEnv.NSM_UAT_URL,
    credentials: getCreds(
      fileEnvs["nsm-uat"]?.user,
      fileEnvs["nsm-uat"]?.password,
      processEnv.NSM_UAT_USER,
      processEnv.NSM_UAT_PASSWORD
    ),
  },
};

let activeEnvName = "nsm-dev";

export const Config = {
  setActiveEnv: (name: string) => {
    if (!environments[name]) {
      throw new Error(`Unknown environment: ${name}. Available: ${Object.keys(environments).join(", ")}`);
    }
    activeEnvName = name;
  },

  get activeEnv(): Environment {
    return environments[activeEnvName] as Environment;
  },

  getAllEnvs: () => environments,

  get baseUrl() { return this.activeEnv.baseUrl; },
  get cleanBaseUrl() { return this.activeEnv.baseUrl.replace(/\/$/, ""); },
  get loginId() { return this.activeEnv.credentials.loginId; },
  get password() {
    const pwd = this.activeEnv.credentials.passwordEncoded;
    return pwd ? atob(pwd) : "";
  },
};
