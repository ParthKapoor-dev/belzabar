import { z } from "zod";

export type Environment = {
  name: string;
  project: string;
  baseUrl: string;
  credentials: {
    loginId: string;
    passwordEncoded: string;
  };
};

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
  
  // Legacy Fallback (for backward compatibility)
  BASE_URL: z.string().optional(),
  API_USER: z.string().optional(),
  API_PASSWORD: z.string().optional(),
});

const processEnv = envSchema.parse(process.env);

// Fallback logic: If specific env vars are missing, try generic ones
const getCreds = (specificUser?: string, specificPass?: string) => {
  return {
    loginId: specificUser || processEnv.API_USER || "",
    passwordEncoded: specificPass || processEnv.API_PASSWORD || "",
  };
};

const environments: Record<string, Environment> = {
  "nsm-dev": {
    name: "nsm-dev",
    project: "NSM",
    baseUrl: processEnv.NSM_DEV_URL,
    credentials: getCreds(processEnv.NSM_DEV_USER, processEnv.NSM_DEV_PASSWORD),
  },
  "nsm-qa": {
    name: "nsm-qa",
    project: "NSM",
    baseUrl: processEnv.NSM_QA_URL,
    credentials: getCreds(processEnv.NSM_QA_USER, processEnv.NSM_QA_PASSWORD),
  },
  "nsm-uat": {
    name: "nsm-uat",
    project: "NSM",
    baseUrl: processEnv.NSM_UAT_URL,
    credentials: getCreds(processEnv.NSM_UAT_USER, processEnv.NSM_UAT_PASSWORD),
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
    return environments[activeEnvName];
  },

  getAllEnvs: () => environments,

  // Backwards compatibility helpers used by existing code, 
  // but now they dynamically point to activeEnv
  get baseUrl() { return this.activeEnv.baseUrl; },
  get cleanBaseUrl() { return this.activeEnv.baseUrl.replace(/\/$/, ""); },
  get loginId() { return this.activeEnv.credentials.loginId; },
  get password() { 
    const pwd = this.activeEnv.credentials.passwordEncoded;
    return pwd ? atob(pwd) : ""; 
  },
};