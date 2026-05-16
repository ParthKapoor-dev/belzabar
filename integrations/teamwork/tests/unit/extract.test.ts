import { describe, expect, test } from "bun:test";
import { extractFromText, extractSql, normalizeHex } from "../../lib/extract";

const HEX_A = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
const HEX_B = "ffeeddccbbaa99887766554433221100";

describe("normalizeHex", () => {
  test("lowercases and strips dashes", () => {
    expect(normalizeHex("A1B2C3D4-E5F6-A1B2-C3D4-E5F6A1B2C3D4")).toBe(
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    );
  });
});

describe("Pattern A — URLs", () => {
  test("extracts AD chain UUID and category from automation-designer URL", () => {
    const ex = extractFromText(`Method: https://host.example.com/automation-designer/forms/${HEX_A}`);
    expect(ex.ad).toEqual([{ uuid: HEX_A, category: "forms", pattern: "ad-url" }]);
  });

  test("extracts PD draft id and version range from a page compare URL", () => {
    const ex = extractFromText(
      `https://host.example.com/ui-designer/page/${HEX_B}/compare?version=397233-402847`,
    );
    expect(ex.pd).toEqual([
      { key: HEX_B, kind: "draft", versionRange: "397233-402847", pattern: "pd-page-url" },
    ]);
  });

  test("extracts PD symbol by name", () => {
    const ex = extractFromText(`https://host.example.com/ui-designer/symbol/n_s_side-bar-nav-link/compare?version=1-2`);
    expect(ex.pd).toEqual([
      { key: "n_s_side-bar-nav-link", kind: "symbol", versionRange: "1-2", pattern: "pd-symbol-url" },
    ]);
  });
});

describe("Pattern B/C — labeled CSV lists", () => {
  test("parses 'PD Pages Published' list as published kind", () => {
    const ex = extractFromText(`PD Pages Published : ${HEX_A},${HEX_B}`);
    expect(ex.hasLabeledList).toBe(true);
    expect(ex.pd.map((p) => p.key).sort()).toEqual([HEX_A, HEX_B].sort());
    expect(ex.pd.every((p) => p.kind === "published")).toBe(true);
  });

  test("parses 'AD (Published Id)' list", () => {
    const ex = extractFromText(`AD (Published Id): ${HEX_A}, ${HEX_B}`);
    expect(ex.ad.map((a) => a.uuid).sort()).toEqual([HEX_A, HEX_B].sort());
  });

  test("ignores non-item labeled lines", () => {
    const ex = extractFromText(`Status: On Hold\nReviewer: someone`);
    expect(ex.ad).toHaveLength(0);
    expect(ex.pd).toHaveLength(0);
    expect(ex.hasLabeledList).toBe(false);
  });
});

describe("SQL extraction", () => {
  test("splits DDL into ddl kind", () => {
    const sql = extractSql(`ALTER TABLE lt261 ADD COLUMN regenerate boolean DEFAULT false;`);
    expect(sql).toEqual([
      { statement: "ALTER TABLE lt261 ADD COLUMN regenerate boolean DEFAULT false;", kind: "ddl" },
    ]);
  });

  test("splits DML into dml kind", () => {
    const sql = extractSql(`UPDATE lt261_meta SET flag = true WHERE id = 7;`);
    expect(sql[0]!.kind).toBe("dml");
  });

  test("captures both kinds from a mixed block", () => {
    const text = `
      CREATE INDEX idx_lt261 ON lt261(form_id);
      INSERT INTO config(key, val) VALUES ('x', 'y');
    `;
    const sql = extractSql(text);
    expect(sql.filter((s) => s.kind === "ddl")).toHaveLength(1);
    expect(sql.filter((s) => s.kind === "dml")).toHaveLength(1);
  });

  test("does not match the word 'update' in prose", () => {
    expect(extractSql("Please update the form and let me know.")).toHaveLength(0);
  });
});

describe("extractFromText — combined dev-note block", () => {
  test("collects AD, PD and SQL from one comment", () => {
    const text = `
      Items to move:
      Methods:
      https://host.example.com/automation-designer/forms/${HEX_A}
      PD Pages Published : ${HEX_B}
      ALTER TABLE lt261 ADD COLUMN x int;
    `;
    const ex = extractFromText(text);
    expect(ex.ad).toHaveLength(1);
    expect(ex.pd).toHaveLength(1);
    expect(ex.sql).toHaveLength(1);
    expect(ex.hasLabeledList).toBe(true);
  });
});
