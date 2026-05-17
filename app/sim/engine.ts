/**
 * FIRE シミュレーションの「唯一の正」（純粋関数・import ゼロ）。
 *
 * §4.1〜4.3 の計算（フィッシャー実質利回り・ライフイベント CF・I列逆算）を
 * TS で1箇所に実装する。Sheets 数式と HTML でロジックを二重化しない。
 * import を持たない（Date/Math のみ）ので、render-html.ts が
 * ts.transpileModule で単一ファイル JS 化してブラウザにそのまま載せられる。
 *
 * I列の逆算式は app/gas/formula-builders.ts: fireNeedValue と同一の算術:
 *   I(r) = nextReq/(1+月次実質利回り) − 年金実質(r) + 支出実質(r)
 * 同一性は tests/sim/engine.test.ts が fireNeedValue と数値比較して固定する。
 *
 * 【自己整合モデル §4.3】I列は「その月に退職したら」を問う指標なので、
 * 退職後社会保険料は selfRetireDate ではなく**当月以降ずっと**発生する前提で
 * 計上する（就労プランの E列＝期末資産トラジェクトリとは別の支出系列）。
 * FIRE可能時期は「以降ずっと 期末資産≥必要資産 を維持する最初の月」
 * （初接触ではない）。verdict はその時退職した場合の終了資産で判定し、
 * FIRE可能時期と矛盾しない。これにより engine はレガシー GAS シミュとは
 * 設計上意図的に乖離する（engine が唯一の正・GAS シミュは撤去対象）。
 */

export interface SimParams {
  /** シミュレーション開始月（YYYY-MM-DD、月初扱い）。通常は実行日。 */
  asOf: string;
  /** 共通 */
  currentAssets: number;
  baseLivingMonthly: number;
  loanMonthly: number;
  loanEndDate: string;
  childSupportMonthly: number;
  childSupportEndDate: string;
  postRetireInsuranceMonthly: number;
  nominalYield: number;
  inflation: number;
  fireSolidThreshold: number;
  fireComfortThreshold: number;
  fireTargetAge: number;
  fireTargetRemain: number;
  simEndAge: number;
  /** 本人 */
  selfBirth: string;
  selfRetireDate: string;
  selfMonthlyIncome: number;
  selfBonusAnnual: number;
  selfRetireLump: number;
  selfPensionAnnual: number;
  selfPensionStartAge: number;
  /** 配偶者 */
  spouseBirth: string;
  spouseRetireDate: string;
  spouseMonthlyIncome: number;
  spouseBonusAnnual: number;
  spouseRetireLump: number;
  spousePensionAnnual: number;
  spousePensionStartAge: number;
}

export interface SimMonth {
  /** "YYYY/MM" */
  ym: string;
  ageSelf: number;
  ageSpouse: number;
  openAssets: number;
  income: number;
  expense: number;
  net: number;
  /** 月次実質利回り */
  realMonthlyYield: number;
  endAssets: number;
  /** FIRE必要資産（目標年齢超は null） */
  fireNeed: number | null;
  /** インフレ実質割戻し係数 (1+i)^(t/12)。デバッグ自己診断用に保持 */
  deflator: number;
  /** 実質割戻し済みの年金月額（本人＋配偶者）。デバッグ自己診断用に保持 */
  pensionReal: number;
}

export interface SimResult {
  monthly: SimMonth[];
  /**
   * 「以降ずっと 期末資産≥FIRE必要資産 を維持する最初の月」("YYYY/MM")。
   * この月に退職すれば年金のみで目標年齢まで持つ＝FIRE可能時期。null＝到達せず。
   */
  fireDate: string | null;
  ageAtFire: number | null;
  /** 就労プラン（リタイア予定日まで就労）で期末資産が初めて負になる月。なければ null */
  depletionMonth: string | null;
  /** 就労プランでシミュレーション終了年齢時点の予想期末資産（参考・透明性のため保持） */
  endAssetsAtSimEnd: number;
  /** fireDate に退職した場合の終了年齢時点資産（年金のみ・一時金は当てにしない）。fireDate なしは null */
  fireEndAssets: number | null;
  /** 余裕度。fireDate があれば fireEndAssets で判定し fireDate と矛盾しない */
  verdict: "盤石" | "余裕" | "達成" | "未達";
}

/** "YYYY/MM/DD" or "YYYY/M/D" or ISO を {y,m,d} に。 */
function parseYmd(s: string): { y: number; m: number; d: number } {
  const parts = s.replace(/-/g, "/").split("/");
  const y = Number(parts[0]);
  const m = Number(parts[1] ?? "1");
  const d = Number(parts[2] ?? "1");
  return { y, m, d };
}

/** y*12+(m-1) の月通し番号。 */
function monthIndex(y: number, m: number): number {
  return y * 12 + (m - 1);
}

/** 月通し番号 → "YYYY/MM" */
function ymLabel(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}/${String(m).padStart(2, "0")}`;
}

/**
 * 誕生日と対象年月から満年齢。GAS の `DATEDIF(誕生日, 当月1日, "Y")` と
 * 同一にする（パリティの権威は再生成済み Sheets）。月次モデルでは対象日は
 * 常に「当月1日」なので、誕生日の日が2日以降なら誕生月の1日時点では
 * まだ誕生日が来ておらず加齢しない。
 * 例: 1977/03/09 生は 2042/03/01 ではまだ64歳、2042/04 で65歳
 *     ＝ GAS の年金開始 `IF(1日 >= EDATE(誕生日,12*65)=2042/03/09)` と一致。
 */
function ageAt(
  birth: { y: number; m: number; d: number },
  y: number,
  m: number,
): number {
  let age = y - birth.y;
  if (m < birth.m) age -= 1;
  else if (m === birth.m && birth.d > 1) age -= 1;
  return age;
}

export function simulate(p: SimParams): SimResult {
  const asOf = parseYmd(p.asOf);
  const selfBirth = parseYmd(p.selfBirth);
  const spouseBirth = parseYmd(p.spouseBirth);
  const selfRetire = parseYmd(p.selfRetireDate);
  const spouseRetire = parseYmd(p.spouseRetireDate);
  const loanEnd = parseYmd(p.loanEndDate);
  const childEnd = parseYmd(p.childSupportEndDate);

  const startIdx = monthIndex(asOf.y, asOf.m);
  const selfRetireIdx = monthIndex(selfRetire.y, selfRetire.m);
  const spouseRetireIdx = monthIndex(spouseRetire.y, spouseRetire.m);
  const loanEndIdx = monthIndex(loanEnd.y, loanEnd.m);
  const childEndIdx = monthIndex(childEnd.y, childEnd.m);

  // フィッシャー方程式: 年実質 → 月実質
  const rYear = (1 + p.nominalYield) / (1 + p.inflation) - 1;
  const rm = Math.pow(1 + rYear, 1 / 12) - 1;

  // ホライズン: 本人が max(終了年齢, FIRE目標年齢) に達する月まで
  const maxAge = Math.max(p.simEndAge, p.fireTargetAge);
  const endIdx = monthIndex(selfBirth.y + maxAge, selfBirth.m);
  const totalMonths = Math.max(endIdx - startIdx + 1, 1);

  const rows: SimMonth[] = [];
  // 年金実質は I列逆算でも使うので別途保持
  const pensionRealArr: number[] = [];
  // I列用「退職済み前提」の支出（名目／実質）。就労プランの expense とは別系列。
  const retiredExpenseNomArr: number[] = [];
  const iColExpenseRealArr: number[] = [];
  const ageSelfArr: number[] = [];

  let prevEnd = p.currentAssets;
  for (let t = 0; t < totalMonths; t++) {
    const idx = startIdx + t;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const ageSelf = ageAt(selfBirth, y, m);
    const ageSpouse = ageAt(spouseBirth, y, m);
    const deflator = Math.pow(1 + p.inflation, t / 12);

    // --- 収入（家計入金モデル）---
    // リタイア予定日は月末日（例 2037/03/31）。その月までは就労なので
    // 給与はリタイア月を含める（idx <= retireIdx）。退職一時金も同月に加算。
    let income = 0;
    if (idx <= selfRetireIdx)
      income += p.selfMonthlyIncome + p.selfBonusAnnual / 12;
    if (idx <= spouseRetireIdx)
      income += p.spouseMonthlyIncome + p.spouseBonusAnnual / 12;

    let pensionReal = 0;
    if (ageSelf >= p.selfPensionStartAge)
      pensionReal += p.selfPensionAnnual / 12 / deflator;
    if (ageSpouse >= p.spousePensionStartAge)
      pensionReal += p.spousePensionAnnual / 12 / deflator;
    income += pensionReal;

    if (idx === selfRetireIdx) income += p.selfRetireLump / deflator;
    if (idx === spouseRetireIdx) income += p.spouseRetireLump / deflator;

    // --- 支出 ---
    let expense = p.baseLivingMonthly;
    if (idx <= loanEndIdx) expense += p.loanMonthly;
    if (idx <= childEndIdx) expense += p.childSupportMonthly;
    // リタイア月は就労（給与あり）なので社会保険料は翌月以降に加算する。
    if (idx > selfRetireIdx) expense += p.postRetireInsuranceMonthly;

    const net = income - expense;
    const openAssets = prevEnd;
    const endAssets = (openAssets + net) * (1 + rm);
    prevEnd = endAssets;

    rows.push({
      ym: ymLabel(idx),
      ageSelf,
      ageSpouse,
      openAssets,
      income,
      expense,
      net,
      realMonthlyYield: rm,
      endAssets,
      fireNeed: null,
      deflator,
      pensionReal,
    });
    pensionRealArr.push(pensionReal);
    // §4.3 自己整合: I列は「この月に退職した」前提なので退職後社会保険料は
    // selfRetireDate ではなく当月以降ずっと計上する（ローン/息子支援は各終了日
    // 依存のまま）。E列は名目固定なので実質化（÷deflator）して保持。
    const retiredExpense =
      p.baseLivingMonthly +
      (idx <= loanEndIdx ? p.loanMonthly : 0) +
      (idx <= childEndIdx ? p.childSupportMonthly : 0) +
      p.postRetireInsuranceMonthly;
    retiredExpenseNomArr.push(retiredExpense);
    iColExpenseRealArr.push(retiredExpense / deflator);
    ageSelfArr.push(ageSelf);
  }

  // --- I列（FIRE必要資産）を末尾から逆算 ---
  // I(r) = nextReq/(1+rm) − 年金実質(r) + 支出実質(r)、年齢>目標年齢は null
  let nextReq = p.fireTargetRemain;
  for (let t = totalMonths - 1; t >= 0; t--) {
    const row = rows[t];
    if (row === undefined) continue;
    if ((ageSelfArr[t] ?? 0) > p.fireTargetAge) {
      row.fireNeed = null;
      continue;
    }
    const need =
      nextReq / (1 + rm) -
      (pensionRealArr[t] ?? 0) +
      (iColExpenseRealArr[t] ?? 0);
    row.fireNeed = need;
    nextReq = need;
  }

  // --- 派生指標 ---
  // FIRE可能時期 = 「以降ずっと 期末資産≥必要資産 を維持する最初の月」。
  // 一時的に超えてもその後割り込むなら不可（最後に割り込んだ次の有効月が答え）。
  let lastFail = -1;
  let lastNonNull = -1;
  let depletionMonth: string | null = null;
  for (let t = 0; t < totalMonths; t++) {
    const r = rows[t];
    if (r === undefined) continue;
    if (depletionMonth === null && r.endAssets < 0) depletionMonth = r.ym;
    if (r.fireNeed === null) continue;
    lastNonNull = t;
    if (r.endAssets < r.fireNeed) lastFail = t;
  }
  let fireDate: string | null = null;
  let ageAtFire: number | null = null;
  let fireIdx = -1;
  if (lastNonNull >= 0 && lastFail < lastNonNull) {
    for (let t = lastFail + 1; t < totalMonths; t++) {
      const r = rows[t];
      if (r === undefined || r.fireNeed === null) continue;
      fireDate = r.ym;
      ageAtFire = r.ageSelf;
      fireIdx = t;
      break;
    }
  }

  // 終了年齢アンカー（本人が simEndAge に達する最初の月、無ければ最終行）
  let anchor = totalMonths - 1;
  for (let t = 0; t < totalMonths; t++) {
    if ((ageSelfArr[t] ?? -1) >= p.simEndAge) {
      anchor = t;
      break;
    }
  }
  // 就労プラン（リタイア予定日まで就労）の終了年齢時点資産（参考・透明性）
  const endAssetsAtSimEnd = rows[anchor]?.endAssets ?? 0;

  // fireDate に退職した場合の終了年齢資産（年金のみ・退職済み支出・一時金なし）。
  // verdict をこれで判定することで FIRE可能時期と矛盾しない。
  let fireEndAssets: number | null = null;
  if (fireIdx >= 0) {
    let a = rows[fireIdx]?.openAssets ?? p.currentAssets;
    for (let t = fireIdx; t <= anchor; t++) {
      const inc = pensionRealArr[t] ?? 0;
      const exp = retiredExpenseNomArr[t] ?? 0;
      a = (a + inc - exp) * (1 + rm);
    }
    fireEndAssets = a;
  }

  let verdict: SimResult["verdict"];
  if (fireDate === null) {
    verdict = "未達";
  } else {
    const fe = fireEndAssets ?? 0;
    if (fe >= p.fireSolidThreshold) verdict = "盤石";
    else if (fe >= p.fireComfortThreshold) verdict = "余裕";
    else if (fe >= 0) verdict = "達成";
    else verdict = "未達";
  }

  return {
    monthly: rows,
    fireDate,
    ageAtFire,
    depletionMonth,
    endAssetsAtSimEnd,
    fireEndAssets,
    verdict,
  };
}
