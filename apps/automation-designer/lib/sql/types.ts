import type { RawMethodResponse } from "../types";

export interface SqlDatabaseField {
  id?: number;
  fieldName: string;
  fieldValue: string;
  securedField?: boolean;
}

export interface SqlDatabaseAuth {
  id: number;
  nickname: string;
  authUsageType?: string;
  derivedAuthType?: string;
  fields?: SqlDatabaseField[];
}

export interface NormalizedSqlDatabase {
  id: number;
  nickname: string;
  source: string | null;
  host: string | null;
  port: string | null;
  authUsageType: string | null;
  derivedAuthType: string | null;
}

export interface SqlOperationInput {
  id: number;
  label?: string;
  produces?: string;
  operationId?: string;
  encodingType?: string;
  automationUserInputs?: SqlOperationInput[];
}

export interface SqlSelectOperation {
  id: number;
  methodUUID: string;
  label?: string;
  operationId?: string;
  automationUserInputs?: SqlOperationInput[];
  automationAPIOutputs?: Array<{
    id: number;
    displayName?: string;
    outputDestination?: string;
    showOnUi?: boolean;
    orderIndex?: number;
  }>;
}

export interface SqlDbResolutionOptions {
  requested?: string;
  envDefault?: string;
  fallbackNickname: string;
}

export interface SqlDbResolutionResult {
  selected: NormalizedSqlDatabase;
  selectedBy: "--db" | "env" | "fallback";
  envDefault?: string;
  requested?: string;
}

export interface SqlRunParseResult {
  rows: unknown[];
  rowCount: number;
  statusCode?: number;
  executionTime?: {
    time: number;
    unit: string;
  };
  success: boolean;
}

export interface BuildSqlPayloadOptions {
  template: RawMethodResponse;
  operation: SqlSelectOperation;
  dbAuthId: number;
  query: string;
}
