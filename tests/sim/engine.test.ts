import { describe, expect, it } from "vitest";
import { fireNeedValue } from "../../app/gas/contract.js";
import {
  defaultRetireAge,
  pensionFactor,
  simulate,
  type SimParams,
} from "../../app/sim/engine.js";

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

  it("自己整合: I列はリタイア前の月も退職後社会保険料を含む（過少評価しない）", () => {
    // 退職済み前提支出 = 基本20万＋保険5万 = 25万/月、rm=0、t0 から 25 ヶ月分。
    expect(m[0]?.fireNeed).toBe(6_250_000); // 250,000 × 25
  });

  it("verdict は fireEndAssets（fireDate に退職した場合）で判定し矛盾しない", () => {
    // 初月 FIRE→年金0・退職済み支出25万を 25 ヶ月 → 1000万−625万=375万。
    expect(r.fireEndAssets).toBe(3_750_000);
    expect(r.fireDate).not.toBeNull();
    expect(r.verdict).not.toBe("未達"); // fireDate があれば未達にならない
  });

  it("退職時アンカー: retireYm=2027/01・assetsAtRetire=退職月の期末資産", () => {
    expect(r.retireYm).toBe("2027/01");
    expect(r.assetsAtRetire).toBe(12_300_000); // m[12].endAssets（退職月）
  });

  it("決定的（同入力→同出力）", () => {
    expect(JSON.stringify(simulate(P))).toBe(JSON.stringify(r));
  });
});

// 収入ゼロで資産が枯渇するシナリオ。どの月に退職しても前進シミュが
// 目標年齢まで持たないので fireDate=null、verdict=未達、fireEndAssets=null。
const DEPLETE: SimParams = {
  ...P,
  currentAssets: 2_000_000,
  baseLivingMonthly: 300_000,
  postRetireInsuranceMonthly: 0,
  selfRetireDate: "2000-01-01", // 過去＝就労収入なし
  selfMonthlyIncome: 0,
  selfRetireLump: 0,
  fireTargetAge: 47,
  simEndAge: 47,
};

describe("simulate: 枯渇シナリオ", () => {
  const r = simulate(DEPLETE);

  it("どの月に退職しても持たない → FIRE 不可・未達・fireEndAssets なし", () => {
    expect(r.fireDate).toBeNull();
    expect(r.ageAtFire).toBeNull();
    expect(r.fireEndAssets).toBeNull();
    expect(r.verdict).toBe("未達");
  });

  it("資産枯渇月を検出（2026/07）し終了年齢資産は負", () => {
    expect(r.depletionMonth).toBe("2026/07"); // 2,000,000 − 300,000×7 < 0
    expect(r.endAssetsAtSimEnd).toBe(-1_900_000); // 2,000,000 − 300,000×13
  });
});

// ageAt の「誕生日の日が2日以降なら誕生月の1日時点ではまだ加齢しない」
// （GAS DATEDIF 契約）。これを落とすと年金開始が1ヶ月早まり ¥523K 規模の
// パリティ乖離を生んだ実バグ経路。決定的に固定する。
describe("simulate: ageAt 誕生日の日 > 1 の年金開始境界", () => {
  const r = simulate({
    ...P,
    selfBirth: "1977-03-09",
    selfPensionAnnual: 1_800_000, // 月15万
    selfPensionStartAge: 65,
    spousePensionStartAge: 100,
    inflation: 0,
    nominalYield: 0,
    simEndAge: 70,
    fireTargetAge: 70,
  });
  const at = (ym: string) => r.monthly.find((m) => m.ym === ym);

  it("2042/03 はまだ64歳・年金ゼロ、2042/04 で65歳・年金15万", () => {
    expect(at("2042/03")?.ageSelf).toBe(64);
    expect(at("2042/03")?.pensionReal).toBe(0);
    expect(at("2042/04")?.ageSelf).toBe(65);
    expect(at("2042/04")?.pensionReal).toBe(150_000);
  });
});

describe("simulate: verdict 閾値（fireEndAssets=3,750,000 を各帯へ）", () => {
  it("盤石: fireEndAssets ≥ 盤石閾値", () => {
    const r = simulate({ ...P, fireSolidThreshold: 3_000_000, fireComfortThreshold: 1_000_000 });
    expect(r.fireEndAssets).toBe(3_750_000);
    expect(r.verdict).toBe("盤石");
  });
  it("余裕: 余裕閾値 ≤ fireEndAssets < 盤石閾値", () => {
    const r = simulate({ ...P, fireSolidThreshold: 5_000_000, fireComfortThreshold: 3_000_000 });
    expect(r.verdict).toBe("余裕");
  });
  it("達成: 0 ≤ fireEndAssets < 余裕閾値", () => {
    expect(simulate(P).verdict).toBe("達成"); // 既定しきい値 1億/5千万
  });
});

describe("simulate: フィッシャー実質利回り（名目>0・インフレ>0）", () => {
  const r = simulate({ ...P, nominalYield: 0.05, inflation: 0.02 });
  const rmExpected = Math.pow(1.05 / 1.02, 1 / 12) - 1;

  it("realMonthlyYield = ((1+n)/(1+i))^(1/12)−1", () => {
    expect(r.monthly[0]?.realMonthlyYield).toBeCloseTo(rmExpected, 12);
  });
  it("deflator は (1+i)^(t/12)（t=12 で 1.02）", () => {
    expect(r.monthly[12]?.deflator).toBeCloseTo(1.02, 10);
  });
  it("資産漸化式 P_t=(P_{t-1}+net)(1+rm) が成立", () => {
    const m0 = r.monthly[0];
    expect(m0?.endAssets).toBeCloseTo(
      ((m0?.openAssets ?? 0) + (m0?.net ?? 0)) * (1 + rmExpected),
      4,
    );
  });
});

// 旧「以降ずっと割り込まない」ルールが返していた誤り（到達しても未達）の回帰防止。
// 就労プランの E列が FIRE後に I列を割り込んでも、その月に退職すれば年金で
// 目標年齢まで持つなら FIRE可能時期は早い月で確定する。
// 構成: 2026/03 に 64 歳で退職・高給与で序盤に資産を積み、2027/01（65歳）から
// 年金開始（§4.1b の繰上げ/繰下げ倍率が 1.0 になる標準受給＝年額そのまま）。
// 退職後の無年金ギャップで E列は I列を割り込むが、2026/04 に退職すれば
// ギャップを越えて年金期に net=0 で持ち切るため、そこが FIRE可能時期。
// 旧ルールは割り込みを見て 2027/01 まで遅延させていた（9ヶ月の誤差）。
const GAP: SimParams = {
  asOf: "2026-01-01",
  currentAssets: 2_000_000,
  baseLivingMonthly: 200_000,
  loanMonthly: 0,
  loanEndDate: "2000-01-01",
  childSupportMonthly: 0,
  childSupportEndDate: "2000-01-01",
  postRetireInsuranceMonthly: 100_000,
  nominalYield: 0,
  inflation: 0,
  fireSolidThreshold: 100_000_000,
  fireComfortThreshold: 50_000_000,
  fireTargetAge: 66,
  fireTargetRemain: 0,
  simEndAge: 66,
  selfBirth: "1962-01-01",
  selfRetireDate: "2026-03-01",
  selfMonthlyIncome: 500_000,
  selfBonusAnnual: 0,
  selfRetireLump: 0,
  selfPensionAnnual: 3_600_000,
  selfPensionStartAge: 65,
  spouseBirth: "1962-01-01",
  spouseRetireDate: "2000-01-01",
  spouseMonthlyIncome: 0,
  spouseBonusAnnual: 0,
  spouseRetireLump: 0,
  spousePensionAnnual: 0,
  spousePensionStartAge: 100,
};

describe("simulate: E列が FIRE後に I列を割り込んでも fireDate は早い月で確定", () => {
  const r = simulate(GAP);
  const at = (ym: string) => r.monthly.find((m) => m.ym === ym);

  it("fireDate は退職して年金まで持ち切れる最初の月（2026/04・64歳）", () => {
    expect(r.fireDate).toBe("2026/04");
    expect(r.ageAtFire).toBe(64);
    expect(r.fireEndAssets).toBe(200_000); // 年金のみ前進シミュの終了年齢資産
    expect(r.verdict).not.toBe("未達"); // fireDate があれば未達にならない
    expect(r.verdict).toBe("達成");
  });

  it("FIRE後の月でも就労プラン E列は I列を割り込む（旧ルールの誤判定経路）", () => {
    const f = at("2026/04"); // = fireDate 当月
    expect(f?.endAssets).toBe(2_600_000);
    expect(f?.fireNeed).toBe(2_700_000);
    expect((f?.endAssets ?? 0) < (f?.fireNeed ?? 0)).toBe(true);
  });
});

// 回帰: インフレ>0 でも I列の支出は実質固定（÷deflator しない）。青（期末資産）
// と同じインフレ前提に統一した整合修正を固定する。n=i で rm=0・
// deflator=(1.05)^(t/12)≠1・年金0・退職済み。旧実装（支出÷deflator）なら
// I列の月次増分が deflator で目減りし「毎月ちょうど +baseLiving」の等差が
// 崩れるので回帰検出できる。
const INFL: SimParams = {
  ...P,
  currentAssets: 1_000_000,
  baseLivingMonthly: 200_000,
  postRetireInsuranceMonthly: 0,
  nominalYield: 0.05,
  inflation: 0.05, // n=i → rm=0、ただし deflator=(1.05)^(t/12)≠1
  selfRetireDate: "2000-01-01", // 過去＝就労収入なし
  selfMonthlyIncome: 0,
  selfRetireLump: 0,
  selfPensionAnnual: 0,
  selfPensionStartAge: 100,
  fireTargetAge: 47,
  simEndAge: 47,
};

describe("simulate: インフレ>0 でも I列支出は実質固定（青と整合・回帰）", () => {
  const r = simulate(INFL);
  const need = r.monthly.filter((x) => x.fireNeed != null);
  const last = need[need.length - 1];
  const prev = need[need.length - 2];

  it("rm=0（n=i）かつ deflator≠1（回帰が成立する前提）", () => {
    expect(r.monthly[0]?.realMonthlyYield).toBeCloseTo(0, 12);
    expect(last?.deflator ?? 0).toBeGreaterThan(1.0001);
  });

  it("I列の月次増分は deflator に依らず厳密に baseLiving（実質固定）", () => {
    // 末尾: nextReq(=fireTargetRemain 0)/(1+0) − 年金0 + 支出20万 = 20万
    expect(last?.fireNeed).toBe(200_000);
    // 1つ前: 20万 + 20万 = 40万（旧実装なら 20万 + 20万/deflator で ≠40万）
    expect(prev?.fireNeed).toBe(400_000);
    expect((prev?.fireNeed ?? 0) - (last?.fireNeed ?? 0)).toBe(200_000);
    expect(last?.fireNeed).toBe(
      fireNeedValue({
        nextReq: 0,
        monthlyRealYield: 0,
        pensionReal: 0,
        expenseReal: 200_000,
      }),
    );
  });
});

// 退職年齢スライダー（任意 selfRetireAge）。指定時は selfRetireDate より優先し
// 「誕生月にその年齢になる月」を退職月とする。未指定は従来挙動（後方互換）。
describe("simulate: selfRetireAge による退職時期上書き（後方互換・往復一致）", () => {
  it("defaultRetireAge は誕生月＝退職日月の通常ケースで日付を厳密復元", () => {
    expect(defaultRetireAge(P.selfBirth, P.selfRetireDate)).toBe(47);
  });

  it("defaultRetireAge は月ずれを Math.floor で早期側に丸める（単調・保守）", () => {
    // 1980-01 生・2027-07 退職（月差 570 ヶ月 = 47.5 年）
    // Math.round だと 48 に切上→2028-01 退職(+6ヶ月後ろ) になり半年で挙動が反転、
    // Math.floor なら 47 →2027-01 退職(-6ヶ月前倒し) で常に保守側。
    expect(defaultRetireAge("1980-01-01", "2027-07-01")).toBe(47);
    expect(defaultRetireAge("1980-01-01", "2027-06-01")).toBe(47);
    expect(defaultRetireAge("1980-01-01", "2027-12-01")).toBe(47);
    expect(defaultRetireAge("1977-03-09", "2037-09-30")).toBe(60);
  });

  it("導出した selfRetireAge を渡すと日付パスと完全一致（後方互換）", () => {
    expect(JSON.stringify(simulate({ ...P, selfRetireAge: 47 }))).toBe(
      JSON.stringify(simulate(P)),
    );
  });

  it("selfRetireAge=46（1歳早く退職）で退職月が t=0（asOf=2026/01）に前倒し", () => {
    const r = simulate({ ...P, selfRetireAge: 46 });
    // 1980-01 + 46歳 = 2026-01 = asOf → m[0] が退職月
    expect(r.monthly[0]?.income).toBe(1_300_000); // 給与30万 + 一時金100万
    expect(r.monthly[1]?.income).toBe(0); // 翌月以降ゼロ
  });
});

// 分配金課税モデル（§4.1a）。総リターンのうち分配分に、課税口座割合だけ
// 20.315% を課税して実効リターンを下げる。NISA分は非課税。
describe("simulate: 分配金課税ドラッグ（NISA 差別化）", () => {
  // リターンを効かせるため名目5%のシナリオ（他は P と同じ・rm が効く）
  const Pg: SimParams = { ...P, nominalYield: 0.05 };
  const DOMESTIC = 0.20315;

  it("dividendYield=0 は税ドラッグ無し＝従来モデルと完全一致（後方互換）", () => {
    expect(JSON.stringify(simulate({ ...Pg, dividendYield: 0, nisaRatio: 0 }))).toBe(
      JSON.stringify(simulate(Pg)),
    );
  });

  it("NISA比率100%なら分配があってもドラッグ0＝従来モデルと一致", () => {
    expect(
      JSON.stringify(simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1 })),
    ).toBe(JSON.stringify(simulate(Pg)));
  });

  it("課税口座100%・分配3%は実効名目を 0.05−0.03×0.20315 へ下げる", () => {
    const r = simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 0 });
    const effNom = 0.05 - 0.03 * DOMESTIC;
    const rmExpect = Math.pow((1 + effNom) / (1 + Pg.inflation), 1 / 12) - 1;
    expect(r.monthly[0]?.realMonthlyYield).toBeCloseTo(rmExpect, 12);
  });

  it("課税口座にある分配が多いほど期末資産は下がる（NISA比率が高いほど有利・単調）", () => {
    const end = (nisa: number) =>
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: nisa }).endAssetsAtSimEnd;
    const allTaxable = end(0);
    const half = end(0.5);
    const allNisa = end(1);
    expect(allTaxable).toBeLessThan(half);
    expect(half).toBeLessThan(allNisa);
    // 全額NISA は分配ゼロ相当＝税ドラッグなしの基準と一致
    expect(allNisa).toBeCloseTo(simulate(Pg).endAssetsAtSimEnd, 6);
  });

  it("nisaRatio は 0..1 にクランプ（範囲外入力でも破綻しない）", () => {
    expect(simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 2 }).endAssetsAtSimEnd).toBe(
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1 }).endAssetsAtSimEnd,
    );
    expect(simulate({ ...Pg, dividendYield: 0.03, nisaRatio: -1 }).endAssetsAtSimEnd).toBe(
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 0 }).endAssetsAtSimEnd,
    );
  });
});

// 外国源泉ドラッグ（§4.1a）。NISA 口座分の分配は国内非課税でも外国源泉税(米株≒10%)
// は回収できず恒久ドラッグになる。NISA100% でも foreignDivShare>0 なら効くのが要点。
describe("simulate: 外国源泉ドラッグ（NISA でも回収不能・§4.1a）", () => {
  const Pg: SimParams = { ...P, nominalYield: 0.05 };
  const DOMESTIC = 0.20315;
  const FOREIGN = 0.1;

  it("foreignDivShare=0 は外国源泉ドラッグ無し＝従来モデルと一致（後方互換）", () => {
    expect(
      JSON.stringify(
        simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1, foreignDivShare: 0 }),
      ),
    ).toBe(JSON.stringify(simulate(Pg)));
  });

  it("NISA100%でも外国源泉ぶんはドラッグが残る（実効名目=0.05−分配×NISA×外国×0.10）", () => {
    const r = simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1, foreignDivShare: 0.8 });
    const effNom = 0.05 - 0.03 * 1 * 0.8 * FOREIGN;
    const rmExpect = Math.pow((1 + effNom) / (1 + Pg.inflation), 1 / 12) - 1;
    expect(r.monthly[0]?.realMonthlyYield).toBeCloseTo(rmExpect, 12);
  });

  it("国内ドラッグと外国ドラッグは加算される（特定50%・NISA50%・外国8割）", () => {
    const r = simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 0.5, foreignDivShare: 0.8 });
    const effNom = 0.05 - (0.03 * 0.5 * DOMESTIC + 0.03 * 0.5 * 0.8 * FOREIGN);
    const rmExpect = Math.pow((1 + effNom) / (1 + Pg.inflation), 1 / 12) - 1;
    expect(r.monthly[0]?.realMonthlyYield).toBeCloseTo(rmExpect, 12);
  });

  it("外国源泉割合が高いほど NISA 資産でも期末は下がる（単調）", () => {
    const end = (f: number) =>
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1, foreignDivShare: f })
        .endAssetsAtSimEnd;
    expect(end(1)).toBeLessThan(end(0.5));
    expect(end(0.5)).toBeLessThan(end(0));
  });

  it("特定口座100%(nisaRatio=0)は外国源泉割合に依らない（外国税額控除で回収＝国内率のみ）", () => {
    const at0 = simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 0, foreignDivShare: 0 })
      .endAssetsAtSimEnd;
    const at1 = simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 0, foreignDivShare: 1 })
      .endAssetsAtSimEnd;
    expect(at0).toBe(at1);
  });

  it("foreignDivShare は 0..1 にクランプ（範囲外入力でも破綻しない）", () => {
    expect(
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1, foreignDivShare: 5 })
        .endAssetsAtSimEnd,
    ).toBe(
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1, foreignDivShare: 1 })
        .endAssetsAtSimEnd,
    );
    expect(
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1, foreignDivShare: -2 })
        .endAssetsAtSimEnd,
    ).toBe(
      simulate({ ...Pg, dividendYield: 0.03, nisaRatio: 1, foreignDivShare: 0 })
        .endAssetsAtSimEnd,
    );
  });
});

// 年金の繰上げ/繰下げ倍率（§4.1b）。65歳=1.0 基準、繰上げ0.4%/月減・繰下げ0.7%/月増。
describe("pensionFactor: 繰上げ/繰下げ倍率（§4.1b）", () => {
  it("65歳=1.0・60歳=0.76(▲24%)・70歳=1.42・75歳=1.84(+84%)", () => {
    expect(pensionFactor(65)).toBeCloseTo(1.0, 10);
    expect(pensionFactor(60)).toBeCloseTo(0.76, 10);
    expect(pensionFactor(70)).toBeCloseTo(1.42, 10);
    expect(pensionFactor(75)).toBeCloseTo(1.84, 10);
  });
  it("受給開始は60〜75歳にクランプ（範囲外でも破綻しない）", () => {
    expect(pensionFactor(55)).toBe(pensionFactor(60));
    expect(pensionFactor(80)).toBe(pensionFactor(75));
  });
});

// 年金の繰上げ/繰下げが simulate に効く（§4.1b）。65歳標準額に倍率を掛けた実額が
// pensionReal に出る。inflation=0 で deflator=1・物価スライド無関係に固定。
describe("simulate: 年金の繰上げ/繰下げ反映（§4.1b）", () => {
  const base: SimParams = {
    ...P,
    selfBirth: "1960-01-01", // asOf 2026-01 で66歳（65歳開始は受給中）
    selfPensionAnnual: 1_200_000, // 65歳標準＝月10万
    inflation: 0,
    nominalYield: 0,
    simEndAge: 76,
    fireTargetAge: 76,
  };
  const pensionAt = (startAge: number, ym: string) =>
    simulate({ ...base, selfPensionStartAge: startAge }).monthly.find(
      (m) => m.ym === ym,
    )?.pensionReal;

  it("65歳開始は標準額そのまま（月10万）", () => {
    expect(pensionAt(65, "2026/01")).toBeCloseTo(100_000, 6);
  });
  it("60歳繰上げは0.76倍（月7.6万）", () => {
    expect(pensionAt(60, "2026/01")).toBeCloseTo(76_000, 6);
  });
  it("70歳繰下げは1.42倍（月14.2万）・ただし70歳到達後から受給", () => {
    expect(pensionAt(70, "2026/01")).toBe(0); // 66歳時点は未受給
    expect(pensionAt(70, "2030/01")).toBeCloseTo(142_000, 6); // 1960+70=2030
  });
});

// 年金の物価スライド（§4.1b）。indexation=0 は名目固定（÷deflator・後方互換）、
// 1 は実質固定（割戻さない）。n=i で rm=0・deflator=(1.02)^(t/12)≠1。
describe("simulate: 年金の物価スライド pensionIndexation（§4.1b）", () => {
  const base: SimParams = {
    ...P,
    selfBirth: "1960-01-01",
    selfPensionAnnual: 1_200_000,
    selfPensionStartAge: 65,
    inflation: 0.02,
    nominalYield: 0.02,
    simEndAge: 76,
    fireTargetAge: 76,
  };
  const pensionAt = (indexation: number, ym: string) =>
    simulate({ ...base, pensionIndexation: indexation }).monthly.find(
      (m) => m.ym === ym,
    )?.pensionReal ?? 0;

  it("indexation=0 は名目固定（実質目減り＝従来 ÷deflator）", () => {
    // t=12（2027/01）deflator=1.02 → 名目10万が実質 100000/1.02
    expect(pensionAt(0, "2027/01")).toBeCloseTo(100_000 / 1.02, 4);
  });
  it("indexation=1 は実質固定（購買力一定＝割戻さない）", () => {
    expect(pensionAt(1, "2027/01")).toBeCloseTo(100_000, 4);
  });
  it("indexation=0.5 は名目固定と実質固定の中間", () => {
    const partial = pensionAt(0.5, "2027/01");
    expect(partial).toBeGreaterThan(100_000 / 1.02);
    expect(partial).toBeLessThan(100_000);
  });
  it("範囲外は0..1にクランプ", () => {
    expect(pensionAt(5, "2027/01")).toBe(pensionAt(1, "2027/01"));
    expect(pensionAt(-3, "2027/01")).toBe(pensionAt(0, "2027/01"));
  });
});

// 配偶者退職年齢の上書き（§4.2）。本人 selfRetireAge と同流儀。未指定は日付（後方互換）。
describe("simulate: spouseRetireAge による配偶者退職時期上書き（後方互換）", () => {
  const base: SimParams = {
    ...P,
    spouseBirth: "1980-01-01",
    spouseRetireDate: "2030-01-01",
    spouseMonthlyIncome: 200_000,
    simEndAge: 50,
    fireTargetAge: 50,
  };
  it("未指定なら spouseRetireDate を使う（後方互換・2028/01 も給与あり）", () => {
    const r = simulate(base);
    expect(r.monthly.find((m) => m.ym === "2028/01")?.income).toBeCloseTo(
      200_000,
      6,
    );
  });
  it("spouseRetireAge=48 は誕生月にその年齢になる月を退職月にする", () => {
    // 1980-01 + 48歳 = 2028-01 が退職月（給与あり）、2028/02 から配偶者給与なし
    const r = simulate({ ...base, spouseRetireAge: 48 });
    const at = (ym: string) => r.monthly.find((m) => m.ym === ym);
    expect(at("2028/01")?.income).toBeCloseTo(200_000, 6); // 退職月は給与あり
    expect(at("2028/02")?.income).toBeCloseTo(0, 6); // 翌月以降なし
  });
});

// 早期退職による年金減額（§4.1b）。退職が60歳より早いと厚生年金の加入期間が短く
// なり報酬比例が積み上がらず65歳基準額そのものが減る（受給開始の繰上げ繰下げとは別軸）。
describe("simulate: 早期退職による年金減額（§4.1b）", () => {
  const base: SimParams = {
    ...P,
    selfBirth: "1960-01-01", // asOf 2026-01 で66歳・65歳開始は受給中
    selfPensionAnnual: 2_000_000, // 60歳まで加入の65歳基準額
    selfPensionStartAge: 65,
    pensionAccrualPerYear: 50_000,
    inflation: 0,
    nominalYield: 0,
    simEndAge: 76,
    fireTargetAge: 76,
  };
  const pensionAt = (retireAge: number) =>
    simulate({ ...base, selfRetireAge: retireAge }).monthly.find(
      (m) => m.ym === "2026/01",
    )?.pensionReal;

  it("退職60歳は満額（減額なし）→ 月 2,000,000/12", () => {
    expect(pensionAt(60)).toBeCloseTo(2_000_000 / 12, 4);
  });
  it("退職55歳は5年×5万=25万減 → (2,000,000−250,000)/12", () => {
    expect(pensionAt(55)).toBeCloseTo((2_000_000 - 250_000) / 12, 4);
  });
  it("pensionAccrualPerYear=0 は減額なし（後方互換）", () => {
    expect(
      simulate({ ...base, pensionAccrualPerYear: 0, selfRetireAge: 55 }).monthly.find(
        (m) => m.ym === "2026/01",
      )?.pensionReal,
    ).toBeCloseTo(2_000_000 / 12, 4);
  });
  // 回帰: 退職年齢を ageAt で月初評価すると、誕生日が月初(1日)でない実データ
  // （1977/03/09 生・2037/03 退職＝ちょうど60歳）を1歳若く誤認し earlyYears が
  // 1年過剰になっていた。退職年齢はスライダー値/日付の floor 換算で取り、誕生日の
  // 「日」に依存しないことを保証する（60歳=満額・55歳=ちょうど5年）。
  it("誕生日が月初でなくても退職年齢は正しい（ageAt 月初規約の巻き込み回帰防止）", () => {
    const at = (retireAge: number) =>
      simulate({
        ...base,
        selfBirth: "1960-03-09", // 日=9>1。ageAt 月初規約だと誕生月退職を1歳若く誤認
        selfRetireAge: retireAge,
      }).monthly.find((m) => m.ym === "2026/01")?.pensionReal;
    expect(at(60)).toBeCloseTo(2_000_000 / 12, 4); // 満額（旧: 1,950,000 で誤減額）
    expect(at(55)).toBeCloseTo((2_000_000 - 250_000) / 12, 4); // 5年（旧: 6年で過剰）
  });
});
