import { describe, expect, test } from "bun:test";
import { buildSqlReadPayload } from "../../lib/sql/payload";
import type { RawMethodResponse } from "../../lib/types";

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
    });

    const inner = JSON.parse(payload.jsonDefinition);
    const service = inner.services[0];

    expect(service.automationAuthId).toBe(55);
    expect(service.testAccountId).toBe(55);

    const queryMapping = service.mappings[0].mappings[0];
    expect(queryMapping.encodingType).toBe("BASE_64");
    expect(decodeBase64(queryMapping.value)).toBe("select * from users limit 1");
  });
});
