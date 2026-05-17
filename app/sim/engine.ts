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
}

export interface SimResult {
  monthly: SimMonth[];
  /** 期末資産が必要ラインを初めて上回る月（"YYYY/MM"）。到達しなければ null */
  fireDate: string | null;
  ageAtFire: number | null;
  /** 期末資産が初めてマイナスになる月（資産枯渇）。なければ null */
  depletionMonth: string | null;
  /** シミュレーション終了年齢時点の予想期末資産 */
  endAssetsAtSimEnd: number;
  /** 終了年齢資産としきい値からの余裕度 */
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

/** 誕生日と対象月初から満年齢（その月の1日時点）。 */
function ageAt(
  birth: { y: number; m: number; d: number },
  y: number,
  m: number,
): number {
  let age = y - birth.y;
  // その月の1日時点。誕生月をまだ迎えていなければ -1。
  if (m < birth.m || (m === birth.m && 1 < birth.d)) age -= 1;
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
  // 年金実質・支出実質は I列逆算でも使うので別途保持
  const pensionRealArr: number[] = [];
  const expenseRealArr: number[] = [];
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
    let income = 0;
    if (idx < selfRetireIdx)
      income += p.selfMonthlyIncome + p.selfBonusAnnual / 12;
    if (idx < spouseRetireIdx)
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
    if (idx >= selfRetireIdx) expense += p.postRetireInsuranceMonthly;

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
    });
    pensionRealArr.push(pensionReal);
    // §4.3: E列は名目固定なので I列内では実質化して計上
    expenseRealArr.push(expense / deflator);
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
      nextReq / (1 + rm) - (pensionRealArr[t] ?? 0) + (expenseRealArr[t] ?? 0);
    row.fireNeed = need;
    nextReq = need;
  }

  // --- 派生指標 ---
  let fireDate: string | null = null;
  let ageAtFire: number | null = null;
  let depletionMonth: string | null = null;
  for (const r of rows) {
    if (
      fireDate === null &&
      r.fireNeed !== null &&
      r.endAssets >= r.fireNeed
    ) {
      fireDate = r.ym;
      ageAtFire = r.ageSelf;
    }
    if (depletionMonth === null && r.endAssets < 0) {
      depletionMonth = r.ym;
    }
  }

  // 終了年齢時点（本人が simEndAge の最初の月、無ければ最終行）
  let endAssetsAtSimEnd = rows.length ? (rows[rows.length - 1]?.endAssets ?? 0) : 0;
  for (const r of rows) {
    if (r.ageSelf >= p.simEndAge) {
      endAssetsAtSimEnd = r.endAssets;
      break;
    }
  }
  let verdict: SimResult["verdict"];
  if (endAssetsAtSimEnd >= p.fireSolidThreshold) verdict = "盤石";
  else if (endAssetsAtSimEnd >= p.fireComfortThreshold) verdict = "余裕";
  else if (endAssetsAtSimEnd >= 0) verdict = "達成";
  else verdict = "未達";

  return {
    monthly: rows,
    fireDate,
    ageAtFire,
    depletionMonth,
    endAssetsAtSimEnd,
    verdict,
  };
}
