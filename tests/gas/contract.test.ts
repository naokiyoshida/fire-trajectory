import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dashLookup,
  fireNeedValue,
  LEGACY_DISCARDED_DASHBOARD_KEYS,
  quoteSheetNameForFormula,
} from "../../app/gas/contract.js";

const GAS_SRC = readFileSync(
  new URL("../../src/gas_receiver_service.gs", import.meta.url),
  "utf8",
);

describe("gas contract (canonical spec)", () => {
  it("quoteSheetNameForFormula escapes single quotes", () => {
    expect(quoteSheetNameForFormula("設定")).toBe("'設定'");
    expect(quoteSheetNameForFormula("a'b")).toBe("'a''b'");
  });

  it("dashLookup builds name-based INDEX/MATCH", () => {
    expect(dashLookup("'設定'", "基本生活費_月額")).toBe(
      `INDEX('設定'!$B:$B, MATCH("基本生活費_月額", '設定'!$A:$A, 0))`,
    );
  });

  it("fireNeedValue matches the hand-computed backward recursion", () => {
    // 年金=月10万、実質支出=月30万、月次実質利回り0.5%
    // 末尾月: 0/1.005 - 100000 + 300000 = 200000
    const last = fireNeedValue({
      nextReq: 0,
      monthlyRealYield: 0.005,
      pensionReal: 100000,
      expenseReal: 300000,
    });
    expect(last).toBeCloseTo(200000, 6);
    // 1つ前の月: 200000/1.005 - 100000 + 300000 ≈ 399004.9751
    const prev = fireNeedValue({
      nextReq: last,
      monthlyRealYield: 0.005,
      pensionReal: 100000,
      expenseReal: 300000,
    });
    expect(prev).toBeCloseTo(399004.97512, 4);
  });

  it("fireNeedValue: より多い年金は必要資産を下げ、より多い支出は上げる（符号の番人）", () => {
    const base = fireNeedValue({
      nextReq: 1_000_000,
      monthlyRealYield: 0.004,
      pensionReal: 120_000,
      expenseReal: 280_000,
    });
    const morePension = fireNeedValue({
      nextReq: 1_000_000,
      monthlyRealYield: 0.004,
      pensionReal: 200_000,
      expenseReal: 280_000,
    });
    const moreExpense = fireNeedValue({
      nextReq: 1_000_000,
      monthlyRealYield: 0.004,
      pensionReal: 120_000,
      expenseReal: 360_000,
    });
    expect(morePension).toBeLessThan(base);
    expect(moreExpense).toBeGreaterThan(base);
  });
});

// 契約テスト: .gs に残る共通ヘルパ／旧キー移行が本モジュールの正準仕様と
// 一致しているか（シミュレーション数式は engine.ts が唯一の正へ移行済み・
// GAS シミュは撤去済み §4.5 なので契約対象外）。
describe("gas_receiver_service.gs ↔ contract", () => {
  it("dashLookup_ template matches dashLookup()", () => {
    expect(GAS_SRC).toContain(
      "return 'INDEX(' + dashRef + '!$B:$B, MATCH(\"' + key + '\", ' + dashRef + '!$A:$A, 0))';",
    );
  });

  it("legacy discarded keys are still migrated in the .gs", () => {
    for (const key of LEGACY_DISCARDED_DASHBOARD_KEYS) {
      expect(GAS_SRC).toContain(`existingValues.hasOwnProperty('${key}')`);
    }
  });
});
