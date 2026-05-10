import { describe, expect, it } from "vitest";
import {
  decrementMonth,
  matchesMonth,
} from "../../../app/scrapers/transactions/navigator.js";

describe("navigator/matchesMonth", () => {
  it("matches YYYY/MM patterns", () => {
    expect(matchesMonth("2026/05", 2026, 5)).toBe(true);
    expect(matchesMonth("2026.05", 2026, 5)).toBe(true);
    expect(matchesMonth("2026年5月", 2026, 5)).toBe(true);
  });

  it("rejects mismatching month/year", () => {
    expect(matchesMonth("2026/04", 2026, 5)).toBe(false);
    expect(matchesMonth("2025/05", 2026, 5)).toBe(false);
  });

  it("falls back to month-only match when year is absent", () => {
    expect(matchesMonth("5月の家計簿", 2026, 5)).toBe(true);
    expect(matchesMonth("4月の家計簿", 2026, 5)).toBe(false);
  });
});

describe("navigator/decrementMonth", () => {
  it("decrements month within a year", () => {
    expect(decrementMonth(2026, 5)).toEqual({ year: 2026, month: 4 });
  });

  it("wraps from January to December of previous year", () => {
    expect(decrementMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
  });
});
