import { describe, expect, test } from "bun:test";
import {
  listMethodFinderCategories,
  normalizeCategoryRecord,
  normalizeMethodRecord,
  searchMethodIndex,
  type MethodFinderIndex,
} from "../../lib/method-finder";

describe("Method finder", () => {
  test("normalizes wrapped and plain category records", () => {
    const wrapped = {
      "74": {
        uuid: "403c868c260221961bb19a821139f1d6",
        name: "NSM.Documents",
        label: "NSM.Documents",
        aliasName: ["NSM.Documents", "NSM-Docs"],
      },
    };

    const plain = {
      uuid: "460b1b91eeded4f733deba1ba6427702",
      name: "NSM.Helpers",
      label: "NSM.Helpers",
      aliasName: ["NSM-Helpers"],
    };

    const first = normalizeCategoryRecord(wrapped);
    const second = normalizeCategoryRecord(plain);

    expect(first?.uuid).toBe("403c868c260221961bb19a821139f1d6");
    expect(first?.aliasName).toEqual(["NSM.Documents", "NSM-Docs"]);

    expect(second?.uuid).toBe("460b1b91eeded4f733deba1ba6427702");
    expect(second?.name).toBe("NSM.Helpers");
  });

  test("normalizes wrapped method record and extracts methodName from jsonDefinition", () => {
    const wrappedMethod = {
      "0": {
        uuid: "4e55820ce5357ce4c1a4aa378f241f36",
        referenceId: "4bac5a7ea357cc8376e998df1baa432c",
        aliasName: "staff.fetch.dcinDetails",
        automationState: "PUBLISHED",
        version: 1,
        createdOn: 1727970370323,
        lastUpdatedOn: 1727970370323,
        jsonDefinition: JSON.stringify({
          name: "_lookupDCIN",
        }),
      },
    };

    const method = normalizeMethodRecord(wrappedMethod, {
      uuid: "460b1b91eeded4f733deba1ba6427702",
      name: "NSM.Helpers",
    });

    expect(method?.methodName).toBe("_lookupDCIN");
    expect(method?.aliasName).toBe("staff.fetch.dcinDetails");
    expect(method?.state).toBe("PUBLISHED");
    expect(method?.categoryName).toBe("NSM.Helpers");
    expect(method?.url).toContain("/automation-designer/NSM.Helpers/");
  });

  test("returns exact matches ahead of fuzzy matches", () => {
    const index: MethodFinderIndex = {
      env: "nsm-dev",
      generatedAt: Date.now(),
      categoryCount: 2,
      methodCount: 3,
      skippedCategories: [],
      categories: [
        {
          uuid: "cat-1",
          name: "NSM.Helpers",
          label: "NSM.Helpers",
          aliasNames: ["NSM-Helpers"],
          methodCount: 2,
        },
        {
          uuid: "cat-2",
          name: "NSM.Documents",
          label: "NSM.Documents",
          aliasNames: [],
          methodCount: 1,
        },
      ],
      methods: [
        {
          uuid: "method-1",
          referenceId: "ref-1",
          aliasName: "staff.fetch.dcinDetails",
          methodName: "_lookupDCIN",
          state: "PUBLISHED",
          version: 1,
          categoryUuid: "cat-1",
          categoryName: "NSM.Helpers",
          createdOn: 1,
          updatedOn: 1,
          url: "https://example.dev/automation-designer/NSM.Helpers/method-1",
        },
        {
          uuid: "method-2",
          referenceId: "ref-2",
          aliasName: "staff.lookup.docs",
          methodName: "_lookupDocuments",
          state: "PUBLISHED",
          version: 1,
          categoryUuid: "cat-2",
          categoryName: "NSM.Documents",
          createdOn: 1,
          updatedOn: 1,
          url: "https://example.dev/automation-designer/NSM.Documents/method-2",
        },
        {
          uuid: "method-3",
          referenceId: "ref-3",
          aliasName: "staff.match.plates",
          methodName: "_plateLookup",
          state: "DRAFT",
          version: 3,
          categoryUuid: "cat-1",
          categoryName: "NSM.Helpers",
          createdOn: 1,
          updatedOn: 1,
          url: "https://example.dev/automation-designer/NSM.Helpers/method-3",
        },
      ],
    };

    const exact = searchMethodIndex(index, "_lookupDCIN", 10);
    expect(exact[0]?.type).toBe("method");
    if (exact[0]?.type === "method") {
      expect(exact[0].methodName).toBe("_lookupDCIN");
    }

    const fuzzy = searchMethodIndex(index, "lkupdcin", 10);
    expect(fuzzy.length).toBeGreaterThan(0);
    const fuzzyMethod = fuzzy.find(item => item.type === "method");
    if (fuzzyMethod?.type === "method") {
      expect(fuzzyMethod.methodName).toBe("_lookupDCIN");
    }
  });

  test("includes category matches and respects limit", () => {
    const index: MethodFinderIndex = {
      env: "nsm-dev",
      generatedAt: Date.now(),
      categoryCount: 2,
      methodCount: 1,
      skippedCategories: [],
      categories: [
        {
          uuid: "cat-1",
          name: "NSM.Helpers",
          label: "NSM.Helpers",
          aliasNames: ["NSM-Helpers"],
          methodCount: 1,
        },
        {
          uuid: "cat-2",
          name: "NSM.Documents",
          label: "NSM.Documents",
          aliasNames: ["NSM-Docs"],
          methodCount: 0,
        },
      ],
      methods: [
        {
          uuid: "method-1",
          referenceId: "ref-1",
          aliasName: "staff.fetch.help",
          methodName: "_helperMethod",
          state: "PUBLISHED",
          version: 1,
          categoryUuid: "cat-1",
          categoryName: "NSM.Helpers",
          createdOn: 1,
          updatedOn: 1,
          url: "https://example.dev/automation-designer/NSM.Helpers/method-1",
        },
      ],
    };

    const matches = searchMethodIndex(index, "helpers", 1);
    expect(matches.length).toBe(1);
    expect(matches[0]?.type).toBe("category");
  });

  test("sorts categories alphabetically", () => {
    const index: MethodFinderIndex = {
      env: "nsm-dev",
      generatedAt: Date.now(),
      categoryCount: 2,
      methodCount: 0,
      skippedCategories: [],
      categories: [
        {
          uuid: "cat-2",
          name: "NSM.Helpers",
          label: "NSM.Helpers",
          aliasNames: [],
          methodCount: 2,
        },
        {
          uuid: "cat-1",
          name: "NSM.Documents",
          label: "NSM.Documents",
          aliasNames: [],
          methodCount: 1,
        },
      ],
      methods: [],
    };

    const categories = listMethodFinderCategories(index);
    expect(categories.map(c => c.name)).toEqual(["NSM.Documents", "NSM.Helpers"]);
  });
});
