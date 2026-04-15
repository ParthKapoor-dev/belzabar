import { CliError, apiFetch } from "@belzabar/core";
import type { SqlDatabaseAuth, SqlSelectOperation, SqlUpdateOperation, SqlInsertOperation, SqlModifyOperation } from "./types";

export async function fetchSqlDatabases(): Promise<SqlDatabaseAuth[]> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/auth", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL databases (${response.status})`, {
      code: "SQL_DATABASES_FETCH_FAILED",
      details: await response.text(),
    });
  }

  return (await response.json()) as SqlDatabaseAuth[];
}

export async function fetchSqlSelectOperation(): Promise<SqlSelectOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/select", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL read operation metadata (${response.status})`, {
      code: "SQL_SELECT_METADATA_FETCH_FAILED",
      details: await response.text(),
    });
  }

  return (await response.json()) as SqlSelectOperation;
}

export async function fetchSqlUpdateOperation(): Promise<SqlUpdateOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/update", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL update operation metadata (${response.status})`, {
      code: "SQL_UPDATE_METADATA_FETCH_FAILED",
      details: await response.text(),
    });
  }

  return (await response.json()) as SqlUpdateOperation;
}

export async function fetchSqlInsertOperation(): Promise<SqlInsertOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/insert", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL insert operation metadata (${response.status})`, {
      code: "SQL_INSERT_METADATA_FETCH_FAILED",
      details: await response.text(),
    });
  }

  return (await response.json()) as SqlInsertOperation;
}

export async function fetchSqlModifyOperation(): Promise<SqlModifyOperation> {
  const response = await apiFetch("/rest/api/automation-systems/db_service/automation-apis/modify", {
    method: "GET",
    authMode: "Bearer",
  });

  if (!response.ok) {
    throw new CliError(`Failed to fetch SQL modify operation metadata (${response.status})`, {
      code: "SQL_MODIFY_METADATA_FETCH_FAILED",
      details: await response.text(),
    });
  }

  return (await response.json()) as SqlModifyOperation;
}
