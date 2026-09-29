// Jenkins REST wire types (job parameters, queue items, builds, console).

export interface JenkinsParameterDefinition {
  name: string;
  type: string;
  description?: string;
  defaultValue?: string | boolean;
  choices?: string[];
}

/** Parameters of the expertly.db-migration job, sent by `triggerBuild`. */
export interface TriggerBuildInput {
  client: string;
  profile: string;
  migrateType: string;
  ids: string[];
  migrationId?: string;
  asyncMigration: "Y" | "N";
  migrateDependent: "Y" | "N";
  devopsTag?: string;
  dryRun?: boolean;
  autoApprove?: boolean;
}

export interface QueueItem {
  id: number;
  url: string;
  why?: string;
  executable?: { number: number; url: string };
  cancelled?: boolean;
}

export interface BuildInfo {
  number: number;
  url: string;
  building: boolean;
  result: "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | null;
  duration: number;
  timestamp: number;
  estimatedDuration: number;
  actions: Array<{ parameters?: Array<{ name: string; value: unknown }> }>;
}

export interface ConsoleChunk {
  text: string;
  nextOffset: number;
  hasMore: boolean;
}
