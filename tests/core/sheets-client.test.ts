import { describe, expect, it } from "vitest";
import { columnLetter } from "../../app/core/sheets-client.js";

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
