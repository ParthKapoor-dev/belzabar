import type { V1RawMethodResponse as RawMethodResponse } from "../types/v1-wire";

interface SqlDatabaseField {
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
  /** Where envDefault came from: config `environments.<env>.sqlDefaultDb` or WI_IMPL_SQL_DEFAULT_DB. */
  envDefaultSource?: "config" | "env";
  /** Optional last-resort nickname (none is built in). */
  fallbackNickname?: string;
}

export type SqlDbSelectedBy = "--db" | "config" | "env" | "fallback";

export interface SqlDbResolutionResult {
  selected: NormalizedSqlDatabase;
  selectedBy: SqlDbSelectedBy;
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

export interface ExecutableCategoryRef {
  id: number;
  name: string;
}

export interface BuildSqlPayloadOptions {
  template: RawMethodResponse;
  operation: SqlSelectOperation;
  dbAuthId: number;
  query: string;
  /**
   * Category to stamp on the synthetic test chain when the fetched template has
   * none. The connected env's server authorizes execution by looking this
   * category up by id, so it MUST exist on that env — otherwise it throws a
   * NullPointerException in AuthorizeExecution.canExecuteCategory. Resolved per
   * env via fetchExecutableCategory(); there is no built-in fallback id.
   */
  fallbackCategory?: ExecutableCategoryRef | null;
}

export type SqlUpdateOperation = SqlSelectOperation;
export type SqlInsertOperation = SqlSelectOperation;
export type SqlModifyOperation = SqlSelectOperation;

export interface SqlUpdateRunParseResult {
  rowsAffected: number;
  statusCode?: number;
  executionTime?: {
    time: number;
    unit: string;
  };
  success: boolean;
}

export interface SqlInsertRunParseResult {
  rowsAffected: number;
  generatedValues: string[];
  statusCode?: number;
  executionTime?: {
    time: number;
    unit: string;
  };
  success: boolean;
}

export interface SqlModifyRunParseResult {
  statusCode?: number;
  executionTime?: {
    time: number;
    unit: string;
  };
  success: boolean;
}
