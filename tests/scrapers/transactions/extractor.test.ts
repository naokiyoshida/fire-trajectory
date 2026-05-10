import { describe, expect, it } from "vitest";
import {
  cleanAmount,
  parseDateMatch,
} from "../../../app/scrapers/transactions/extractor.js";

describe("extractor/cleanAmount", () => {
  it("removes commas, currency symbol and whitespace", () => {
    expect(cleanAmount("-1,234円")).toBe("-1234");
    expect(cleanAmount("  500 ")).toBe("500");
  });

  it("strips (振替) marker", () => {
    expect(cleanAmount("1,000(振替)")).toBe("1000");
  });

  it("preserves a leading minus sign", () => {
    expect(cleanAmount("-29,580円")).toBe("-29580");
  });
});

describe("extractor/parseDateMatch", () => {
  it("parses M/D format", () => {
    expect(parseDateMatch("5/1")).toEqual({ month: 5, day: 1 });
    expect(parseDateMatch("12/31")).toEqual({ month: 12, day: 31 });
  });

  it("accepts full-width slash", () => {
    expect(parseDateMatch("5／3")).toEqual({ month: 5, day: 3 });
  });

  it("returns null for invalid month/day", () => {
    expect(parseDateMatch("13/1")).toBeNull();
    expect(parseDateMatch("5/32")).toBeNull();
    expect(parseDateMatch("nope")).toBeNull();
  });
});
