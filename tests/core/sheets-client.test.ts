import { describe, expect, it } from "vitest";
import { columnLetter, quoteSheetName } from "../../app/core/sheets-client.js";

describe("sheets-client/columnLetter", () => {
  it("converts 1..26 to A..Z", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(7)).toBe("G");
    expect(columnLetter(26)).toBe("Z");
  });

  it("handles two-letter columns", () => {
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(52)).toBe("AZ");
    expect(columnLetter(53)).toBe("BA");
  });

  it("rejects non-positive input", () => {
    expect(() => columnLetter(0)).toThrow();
  });
});

describe("sheets-client/quoteSheetName", () => {
  it("wraps Japanese sheet names in single quotes", () => {
    expect(quoteSheetName("取引履歴")).toBe("'取引履歴'");
    expect(quoteSheetName("資産推移")).toBe("'資産推移'");
  });

  it("escapes embedded single quotes by doubling", () => {
    expect(quoteSheetName("a'b")).toBe("'a''b'");
  });

  it("wraps ASCII names too (still valid in A1 notation)", () => {
    expect(quoteSheetName("Sheet1")).toBe("'Sheet1'");
  });
});
