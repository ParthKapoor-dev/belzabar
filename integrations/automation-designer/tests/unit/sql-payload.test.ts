import { describe, expect, test } from "bun:test";
import { buildSqlReadPayload } from "../../lib/sql/payload";
import type { V1RawMethodResponse as RawMethodResponse } from "../../lib/types/v1-wire";

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

describe("SQL payload builder", () => {
  test("injects db auth id and SQL query mapping", () => {
    const template: RawMethodResponse = {
      uuid: "method-uuid",
      referenceId: "ref-id",
      aliasName: "Read Data",
      automationState: "PUBLISHED",
      createdOn: Date.now(),
      lastUpdatedOn: Date.now(),
      lastUpdatedBy: "tester",
      jsonDefinition: JSON.stringify({
        name: "Read Data",
        inputs: [],
        services: [
          {
            automationApiId: 25,
            automationAuthId: 18,
            testAccountId: 18,
            mappings: [
              {
                automationUserInputId: 182,
                mappings: [
                  {
                    automationUserInputId: 183,
                    value: "b2xkLXF1ZXJ5",
                    encodingType: "BASE_64",
                    uiRepresentation: "CUSTOM",
                  },
                ],
              },
            ],
          },
        ],
      }),
    };

    const operation = {
      id: 25,
      methodUUID: "method-uuid",
      automationUserInputs: [
        {
          id: 182,
          produces: "body",
          automationUserInputs: [
            {
              id: 183,
              label: "SQLQuery",
              produces: "queryString",
              encodingType: "BASE_64",
            },
          ],
        },
      ],
    };

    const payload = buildSqlReadPayload({
      template,
      operation,
      dbAuthId: 55,
      query: "select * from users limit 1",
      fallbackCategory: { id: 1, name: "Helpers" },
    });

    const inner = JSON.parse(payload.jsonDefinition);
    const service = inner.services[0];

    expect(service.automationAuthId).toBe(55);
    expect(service.testAccountId).toBe(55);

    const queryMapping = service.mappings[0].mappings[0];
    expect(queryMapping.encodingType).toBe("BASE_64");
    expect(decodeBase64(queryMapping.value)).toBe("select * from users limit 1");
  });

  function makeTemplate(category?: unknown): RawMethodResponse {
    return {
      uuid: "method-uuid",
      referenceId: "ref-id",
      aliasName: "Read Data",
      automationState: "PUBLISHED",
      createdOn: 0,
      lastUpdatedOn: 0,
      lastUpdatedBy: "tester",
      ...(category !== undefined ? { category } : {}),
      jsonDefinition: JSON.stringify({
        name: "Read Data",
        inputs: [],
        services: [{ automationApiId: 25, mappings: [], outputs: [] }],
      }),
    } as RawMethodResponse;
  }

  const operation = {
    id: 25,
    methodUUID: "method-uuid",
    automationUserInputs: [
      {
        id: 182,
        produces: "body",
        automationUserInputs: [{ id: 183, label: "SQLQuery", produces: "queryString", encodingType: "BASE_64" }],
      },
    ],
  };

  test("no template category and no env category → SQL_NO_EXECUTABLE_CATEGORY (no built-in id)", () => {
    expect(() =>
      buildSqlReadPayload({
        template: makeTemplate(),
        operation,
        dbAuthId: 55,
        query: "select 1",
      }),
    ).toThrow(expect.objectContaining({ code: "SQL_NO_EXECUTABLE_CATEGORY" }));
  });

  test("stamps the env-resolved fallbackCategory when the template has none", () => {
    const payload = buildSqlReadPayload({
      template: makeTemplate(),
      operation,
      dbAuthId: 55,
      query: "select 1",
      fallbackCategory: { id: 1200, name: "Helpers.CSV" },
    });
    expect((payload as any).category).toEqual({ id: 1200, name: "Helpers.CSV" });
  });

  test("prefers the template's own category over the fallback", () => {
    const payload = buildSqlReadPayload({
      template: makeTemplate({ id: 999, name: "Real.Category" }),
      operation,
      dbAuthId: 55,
      query: "select 1",
      fallbackCategory: { id: 1200, name: "Helpers.CSV" },
    });
    expect((payload as any).category).toEqual({ id: 999, name: "Real.Category" });
  });
});
