import { describe, expect, it } from "vitest";
import { parseJpyAmount } from "../../../app/scrapers/assets/extractor.js";

describe("assets/extractor/parseJpyAmount", () => {
  it("parses positive amounts with commas and currency symbol", () => {
    expect(parseJpyAmount("28,368,979円")).toBe(28368979);
    expect(parseJpyAmount("850,237円")).toBe(850237);
  });

  it("parses negative amounts", () => {
    expect(parseJpyAmount("-36,000円")).toBe(-36000);
  });

  it("returns null for unparseable strings", () => {
    expect(parseJpyAmount("---")).toBeNull();
    expect(parseJpyAmount("")).toBeNull();
  });

  it("ignores leading text like 資産総額：", () => {
    expect(parseJpyAmount("資産総額：28,368,979円")).toBe(28368979);
    expect(parseJpyAmount("負債総額：\n  11,142,520円")).toBe(11142520);
  });
});
