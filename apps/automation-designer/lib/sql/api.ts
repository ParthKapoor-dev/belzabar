import { CliError } from "@belzabar/core";
import { apiFetch } from "../api";
import type { SqlDatabaseAuth, SqlSelectOperation } from "./types";

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
