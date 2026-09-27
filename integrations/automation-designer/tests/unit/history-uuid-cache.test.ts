import { describe, expect, test } from "bun:test";
import { historyUuidCacheKey } from "../../lib/api/v1";

describe("_historyUuidCache key (AD-24)", () => {
  test("is scoped by env", () => {
    expect(historyUuidCacheKey("nsm-dev", "listAll")).toBe("nsm-dev:listAll");
    expect(historyUuidCacheKey("nsm-qa", "listAll")).not.toBe(historyUuidCacheKey("nsm-dev", "listAll"));
  });
});
