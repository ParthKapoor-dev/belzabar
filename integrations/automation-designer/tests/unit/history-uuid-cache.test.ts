import { describe, expect, test } from "bun:test";
import { historyUuidCacheKey } from "../../lib/api/v1";

describe("_historyUuidCache key (AD-24)", () => {
  test("is scoped by env", () => {
    expect(historyUuidCacheKey("orb-dev", "listAll")).toBe("orb-dev:listAll");
    expect(historyUuidCacheKey("orb-qa", "listAll")).not.toBe(historyUuidCacheKey("orb-dev", "listAll"));
  });
});
