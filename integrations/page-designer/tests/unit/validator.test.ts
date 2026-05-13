import { describe, test, expect } from "bun:test";
import { parsePage } from "../../lib/parser/index";
import { validateHydrated, partitionBySeverity } from "../../lib/validator/index";
import type { RawPageResponse } from "../../lib/types/wire";

function wrap(inner: unknown, overrides: Partial<RawPageResponse> = {}): RawPageResponse {
  return {
    id: "t1",
    name: "test",
    status: "DRAFT",
    configuration: JSON.stringify(inner),
    ...overrides,
  };
}

function rootPage(extraInner: Record<string, unknown> = {}, extraRoot: Record<string, unknown> = {}) {
  return {
    __version: 5,
    layout: {
      id: "__node_id_root",
      name: "div",
      props: { layout: { type: "flex" } },
      children: [],
      _elementId: "__element_id_root",
      unSelectable: true,
      __LAYOUT_CONFIG_METADATA: {},
      ...extraRoot,
    },
    styles: "",
    variables: { generated: [], userDefined: [], derived: [] },
    httpRequests: { generated: [], userDefined: [] },
    ...extraInner,
  };
}

function codes(issues: { code: string }[]) {
  return issues.map((i) => i.code);
}

describe("validator — existing rules", () => {
  test("FORM_FIELD_PROPS fires when exp-form-field uses props instead of field", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [{ id: "bad", name: "exp-form-field", props: { type: "text" } }],
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("FORM_FIELD_PROPS");
  });

  test("ORPHAN_BINDING fires for undefined variable references", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [
            { id: "leaf", name: "div", props: { innerHTML: "{%doesNotExist%}" } },
          ],
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("ORPHAN_BINDING");
  });

  test("UNUSED_VARIABLE fires when variable is defined but never referenced", () => {
    const page = parsePage(
      wrap(
        rootPage({
          variables: { generated: [], userDefined: [{ name: "unused", type: "String", initialValue: "" }], derived: [] },
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("UNUSED_VARIABLE");
  });

  test("INVALID_SLIDE_TOGGLE fires on mat-slide-toggle", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [{ id: "tog", name: "mat-slide-toggle", props: {} }],
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("INVALID_SLIDE_TOGGLE");
    // Must NOT also fire CUSTOM_HTML_IN_COMPONENT for the same node.
    const customCount = issues.filter((i) => i.code === "CUSTOM_HTML_IN_COMPONENT").length;
    expect(customCount).toBe(0);
  });

  test("TABLE_NO_DATASOURCE warn fires when datasourceState missing", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [{ id: "t", name: "exp-data-table", props: { "[rowData]": "{%data%}" } }],
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("TABLE_NO_DATASOURCE");
  });

  test("DYNAMIC_COLS_INITIAL warn fires when [columns] variable has initialValue", () => {
    const page = parsePage(
      wrap(
        rootPage(
          {
            variables: {
              generated: [],
              userDefined: [{ name: "cols", type: "Any", initialValue: [1, 2] }],
              derived: [],
            },
          },
          {
            children: [
              { id: "t", name: "exp-data-table", props: { "[columns]": "{%cols%}", "[rowData]": "{%x%}", datasourceState: "initial" } },
            ],
          },
        ),
      ),
    );
    const issues = validateHydrated(page);
    // Also produces ARRAY_INITIAL_VALUE on `cols` — OK, both are intended.
    expect(codes(issues)).toContain("DYNAMIC_COLS_INITIAL");
  });

  test("CHILDREN_NOT_ARRAY fires when children is object-keyed", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: { "0": { id: "a", name: "span" } },
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("CHILDREN_NOT_ARRAY");
  });

  test("EMPTY_EVENT_META fires when serviceCall.eventMeta is {}", () => {
    const page = parsePage(
      wrap(
        rootPage({
          httpRequests: {
            generated: [],
            userDefined: [
              {
                meta: { serviceCall: { label: "x", callId: "y", eventMeta: {} } },
                request: { url: "/x" },
                handler: { success: [], error: [], inProgress: "" },
                trigger: [],
              },
            ],
          },
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("EMPTY_EVENT_META");
  });
});

describe("validator — invariant rules", () => {
  test("ARRAY_INITIAL_VALUE fires on array-initialValue variable", () => {
    const page = parsePage(
      wrap(
        rootPage({
          variables: {
            generated: [],
            userDefined: [{ name: "items", type: "Any", initialValue: [1, 2] }],
            derived: [],
          },
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("ARRAY_INITIAL_VALUE");
  });

  test("DERIVED_IN_INNERHTML fires when derived var used in [innerHTML]", () => {
    const page = parsePage(
      wrap(
        rootPage(
          {
            variables: {
              generated: [],
              userDefined: [{ name: "raw", type: "String", initialValue: "hi" }],
              derived: [{ name: "upper", from: ["raw"], spec: "(function(p){return p.raw.toUpperCase();})" }],
            },
          },
          {
            children: [
              { id: "n", name: "div", props: { "[innerHTML]": "{%upper%}" } },
            ],
          },
        ),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("DERIVED_IN_INNERHTML");
  });

  test("PHONE_FIELD_TYPE fires on exp-form-field type=\"phone\"", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [
            {
              id: "ph",
              name: "exp-form-field",
              field: { name: "__f_phone", type: "phone", label: "Phone" },
            },
          ],
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("PHONE_FIELD_TYPE");
  });

  test("ROOT_LAYOUT_MALFORMED fires when page root lacks unSelectable", () => {
    const page = parsePage(
      wrap({
        __version: 5,
        layout: {
          id: "__root",
          name: "div",
          props: { layout: { type: "flex" } },
          children: [],
          _elementId: "__er",
          // unSelectable intentionally missing
        },
        styles: "",
        variables: { generated: [], userDefined: [], derived: [] },
        httpRequests: { generated: [], userDefined: [] },
      }),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("ROOT_LAYOUT_MALFORMED");
  });

  test("BUTTON_DYNAMIC_CLASSNAME fires on dynamic [className] binding", () => {
    const page = parsePage(
      wrap(
        rootPage(
          {
            variables: {
              generated: [],
              userDefined: [{ name: "c", type: "String", initialValue: "" }],
              derived: [],
            },
          },
          {
            children: [
              { id: "b", name: "button", props: { "[className]": "{%c%}", innerHTML: "ok" } },
            ],
          },
        ),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("BUTTON_DYNAMIC_CLASSNAME");
  });

  test("DUPLICATE_ELEMENT_IDS fires on repeated node id", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [
            { id: "same", name: "span" },
            { id: "same", name: "span" },
          ],
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("DUPLICATE_ELEMENT_IDS");
  });

  test("CUSTOM_HTML_IN_COMPONENT warn fires on raw <input>", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [{ id: "i", name: "input", props: { type: "text" } }],
        }),
      ),
    );
    const issues = validateHydrated(page);
    expect(codes(issues)).toContain("CUSTOM_HTML_IN_COMPONENT");
  });
});

describe("partitionBySeverity", () => {
  test("splits errors and warnings correctly", () => {
    const page = parsePage(
      wrap(
        rootPage({}, {
          children: [
            { id: "bad", name: "exp-form-field", props: { type: "text" } }, // error
            { id: "t", name: "exp-data-table", props: { "[rowData]": "{%x%}" } }, // warn
          ],
        }),
      ),
    );
    const issues = validateHydrated(page);
    const { errors, warnings } = partitionBySeverity(issues);
    expect(errors.every((e) => e.severity === "error")).toBe(true);
    expect(warnings.every((w) => w.severity === "warn")).toBe(true);
    expect(errors.length + warnings.length).toBe(issues.length);
  });
});

describe("validator — clean page produces no errors", () => {
  test("minimal valid page with one used variable has zero errors", () => {
    const inner = rootPage(
      {
        variables: {
          generated: [],
          userDefined: [{ name: "greeting", type: "String", initialValue: "hi" }],
          derived: [],
        },
      },
      {
        children: [
          {
            id: "leaf",
            name: "div",
            props: { "[innerHTML]": "{%greeting%}" },
            _elementId: "e_leaf",
          },
        ],
      },
    );
    const page = parsePage(wrap(inner));
    const { errors } = partitionBySeverity(validateHydrated(page));
    expect(errors).toEqual([]);
  });
});
