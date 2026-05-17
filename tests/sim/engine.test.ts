import { describe, expect, it } from "vitest";
import { fireNeedValue } from "../../app/gas/formula-builders.js";
import { simulate, type SimParams } from "../../app/sim/engine.js";

// 検証しやすいよう inflation=0 / nominalYield=0（rm=0, deflator=1）の
// 決定的シナリオ。本人 1980-01 生 / 2027-01 リタイア / 一時金100万。
const P: SimParams = {
  asOf: "2026-01-01",
  currentAssets: 10_000_000,
  baseLivingMonthly: 200_000,
  loanMonthly: 0,
  loanEndDate: "2000-01-01",
  childSupportMonthly: 0,
  childSupportEndDate: "2000-01-01",
  postRetireInsuranceMonthly: 50_000,
  nominalYield: 0,
  inflation: 0,
  fireSolidThreshold: 100_000_000,
  fireComfortThreshold: 50_000_000,
  fireTargetAge: 48,
  fireTargetRemain: 0,
  simEndAge: 48,
  selfBirth: "1980-01-01",
  selfRetireDate: "2027-01-01",
  selfMonthlyIncome: 300_000,
  selfBonusAnnual: 0,
  selfRetireLump: 1_000_000,
  selfPensionAnnual: 0,
  selfPensionStartAge: 100,
  spouseBirth: "1980-01-01",
  spouseRetireDate: "2000-01-01",
  spouseMonthlyIncome: 0,
  spouseBonusAnnual: 0,
  spouseRetireLump: 0,
  spousePensionAnnual: 0,
  spousePensionStartAge: 100,
};

describe("simulate", () => {
  const r = simulate(P);
  const m = r.monthly;

  it("ホライズンは本人 max(終了,目標)年齢まで（2026/01..2028/01 = 25ヶ月）", () => {
    expect(m.length).toBe(25);
    expect(m[0]?.ym).toBe("2026/01");
    expect(m[24]?.ym).toBe("2028/01");
  });

  it("rm=0（名目=インフレ=0）", () => {
    expect(m[0]?.realMonthlyYield).toBeCloseTo(0, 12);
  });

  it("収入: リタイア月まで給与あり＋同月に一時金、翌月以降ゼロ", () => {
    expect(m[0]?.income).toBe(300_000); // t=0 就労
    expect(m[11]?.income).toBe(300_000); // t=11 まだ就労
    expect(m[12]?.income).toBe(1_300_000); // t=12 リタイア月=給与+一時金
    expect(m[13]?.income).toBe(0); // 翌月以降ゼロ
  });

  it("支出: 基本生活費＋リタイア翌月以降に社会保険料を加算", () => {
    expect(m[0]?.expense).toBe(200_000);
    expect(m[12]?.expense).toBe(200_000); // リタイア月は就労扱い→保険料なし
    expect(m[24]?.expense).toBe(250_000); // 翌月以降は +50,000
  });

  it("資産は P_t=(P_{t-1}+net)(1+rm) で更新（rm=0）", () => {
    expect(m[0]?.endAssets).toBe(10_100_000); // +100,000
    expect(m[11]?.endAssets).toBe(11_200_000); // 12ヶ月×+100,000
    expect(m[12]?.endAssets).toBe(12_300_000); // +1,100,000(給与+一時金-基本)
    expect(m[24]?.endAssets).toBe(9_300_000); // 以降 -250,000×12
  });

  it("I列末尾は fireNeedValue と一致（数式の単一の正を固定）", () => {
    const last = m[24];
    expect(last?.fireNeed).toBe(250_000);
    expect(last?.fireNeed).toBe(
      fireNeedValue({
        nextReq: P.fireTargetRemain,
        monthlyRealYield: 0,
        pensionReal: 0,
        expenseReal: 250_000,
      }),
    );
  });

  it("派生指標: 既に必要ライン超なので初月 FIRE 可能、枯渇なし、達成判定", () => {
    expect(r.fireDate).toBe("2026/01");
    expect(r.ageAtFire).toBe(46);
    expect(r.depletionMonth).toBeNull();
    expect(r.endAssetsAtSimEnd).toBe(9_300_000);
    expect(r.verdict).toBe("達成");
  });

  it("決定的（同入力→同出力）", () => {
    expect(JSON.stringify(simulate(P))).toBe(JSON.stringify(r));
  });
});
