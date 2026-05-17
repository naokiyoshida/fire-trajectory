import { describe, expect, it } from "vitest";
import type { SimMonth } from "../../app/sim/engine.js";
import { compareToSheet } from "../../app/sim/parity.js";

function row(ym: string, end: number, need: number | null): SimMonth {
  return {
    ym,
    ageSelf: 50,
    ageSpouse: 50,
    openAssets: 0,
    income: 0,
    expense: 0,
    net: 0,
    realMonthlyYield: 0,
    endAssets: end,
    fireNeed: need,
  };
}

const engineRows = [
  row("2026/01", 10_000_000, 5_000_000),
  row("2026/02", 10_100_000, 4_900_000),
];

describe("compareToSheet", () => {
  it("許容内なら乖離なし、最大差を報告", () => {
    const sheet = [
      ["2026/01", "", "", "", "", "", "", 10_000_010, 5_000_000],
      ["2026/02", "", "", "", "", "", "", 10_100_000, 4_900_020],
    ];
    const rep = compareToSheet(engineRows, sheet);
    expect(rep.comparedCount).toBe(2);
    expect(rep.firstDivergence).toBeNull();
    expect(rep.maxEndDiff).toBe(10);
    expect(rep.maxNeedDiff).toBe(20);
  });

  it("相対許容を超える差は firstDivergence に出る", () => {
    const sheet = [
      ["2026/01", "", "", "", "", "", "", 12_000_000, 5_000_000], // +20%
    ];
    const rep = compareToSheet(engineRows, sheet);
    expect(rep.firstDivergence).toContain("2026/01 期末資産");
    expect(rep.maxEndDiff).toBe(2_000_000);
  });

  it("年月の表記ゆれ（2026/1, 日付つき）も突き合わせる", () => {
    const sheet = [["2026/1", "", "", "", "", "", "", 10_000_000, 5_000_000]];
    const rep = compareToSheet(engineRows, sheet);
    expect(rep.comparedCount).toBe(1);
    expect(rep.firstDivergence).toBeNull();
  });
});
