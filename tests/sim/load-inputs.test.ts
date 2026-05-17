import { describe, expect, it } from "vitest";
import { buildSimParams, todayAsOf } from "../../app/sim/load-inputs.js";

// 設定シート [A=項目名, B=値] の最小フルセット
const FULL: [string, unknown][] = [
  ["現在の資産", 28_980_000],
  ["基本生活費_月額", 350_000],
  ["ローン月額", 100_000],
  ["ローン完済予定日", "2042/03/31"],
  ["息子支援月額", 50_000],
  ["息子支援終了日", "2028/03/31"],
  ["退職後社会保険料_月額", 50_000],
  ["運用利回り_名目", 0.05],
  ["インフレ率", 0.02],
  ["FIRE射程_盤石閾値", 30_000_000],
  ["FIRE射程_余裕閾値", 5_000_000],
  ["FIRE必要資産_目標年齢", 100],
  ["FIRE必要資産_目標残額", 0],
  ["シミュレーション終了年齢", 100],
  ["本人誕生日", "1977/03/09"],
  ["リタイア予定日", "2037/03/31"],
  ["本人月収_家計入金", 300_000],
  ["本人ボーナス_年額_家計入金", 900_000],
  ["本人退職時一時金", 3_000_000],
  ["本人年金_年額", 1_800_000],
  ["本人年金開始年齢", 65],
  ["配偶者誕生日", "1976/06/27"],
  ["配偶者退職予定日", "2041/06/30"],
  ["配偶者月収_家計入金", 130_000],
  ["配偶者ボーナス_年額_家計入金", 0],
  ["配偶者退職時一時金", 0],
  ["配偶者年金_年額", 780_000],
  ["配偶者年金開始年齢", 65],
];

describe("buildSimParams", () => {
  it("全項目を型に応じてパースする", () => {
    const p = buildSimParams(FULL, "2026-05-01");
    expect(p.asOf).toBe("2026-05-01");
    expect(p.currentAssets).toBe(28_980_000);
    expect(p.nominalYield).toBe(0.05);
    expect(p.selfBirth).toBe("1977-03-09"); // 0 埋め ISO
    expect(p.spouseRetireDate).toBe("2041-06-30");
    expect(p.selfPensionStartAge).toBe(65);
  });

  it("¥・カンマ付き文字列も数値化", () => {
    const rows = FULL.map((r) =>
      r[0] === "現在の資産" ? [r[0], "¥28,980,000"] : r,
    );
    expect(buildSimParams(rows, "2026-05-01").currentAssets).toBe(28_980_000);
  });

  it("必須項目欠落は項目名つきで例外", () => {
    const rows = FULL.filter((r) => r[0] !== "インフレ率");
    expect(() => buildSimParams(rows, "2026-05-01")).toThrow("インフレ率");
  });

  it("任意項目（退職後社会保険料_月額）未掲載は既定0で続行し通知", () => {
    const rows = FULL.filter((r) => r[0] !== "退職後社会保険料_月額");
    const notes: string[] = [];
    const p = buildSimParams(rows, "2026-05-01", (n) => notes.push(...n));
    expect(p.postRetireInsuranceMonthly).toBe(0);
    expect(notes.join()).toContain("退職後社会保険料_月額=0");
  });

  it("todayAsOf は当月1日 ISO", () => {
    expect(todayAsOf(new Date("2026-05-17T09:00:00Z"))).toBe("2026-05-01");
  });
});
