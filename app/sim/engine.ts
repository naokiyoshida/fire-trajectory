/**
 * FIRE シミュレーションの「唯一の正」（純粋関数・import ゼロ）。
 *
 * §4.1〜4.3 の計算（フィッシャー実質利回り・ライフイベント CF・I列逆算）を
 * TS で1箇所に実装する。Sheets 数式と HTML でロジックを二重化しない。
 * import を持たない（Date/Math のみ）ので、render-html.ts が
 * ts.transpileModule で単一ファイル JS 化してブラウザにそのまま載せられる。
 *
 * I列の逆算式は app/gas/contract.ts: fireNeedValue と同一の算術:
 *   I(r) = nextReq/(1+月次実質利回り) − 年金実質(r) + 支出実質(r)
 * 同一性は tests/sim/engine.test.ts が fireNeedValue と数値比較して固定する。
 *
 * 【自己整合モデル §4.3】I列は「その月に退職したら」を問う指標なので、
 * 退職後社会保険料は selfRetireDate ではなく**当月以降ずっと**発生する前提で
 * 計上する（就労プランの E列＝期末資産トラジェクトリとは別の支出系列）。
 * インフレ前提は E列と統一する：支出は実質固定（÷deflator しない＝生活費は
 * 購買力一定）、年金のみ名目固定（pensionReal で÷deflator）。これにより青
 * （期末資産）と橙（I列）が同一の漸化式となり、傾きの振る舞いが整合する
 * （かつて I列だけ支出を÷deflator していた非対称を撤去）。
 * 入金側の各項目のインフレ扱いも明示しておく：
 *   - 給与・賞与（selfMonthlyIncome, selfBonusAnnual, spouse同様）: ÷deflator
 *     しない＝「毎年インフレ連動で名目昇給する」を暗黙仮定。設定シートの
 *     値は「現時点の実質購買力での給与」と解釈する。
 *   - 退職一時金（selfRetireLump, spouseRetireLump）: ÷deflator する＝
 *     退職月の名目額として入力する想定（ねんきん定期便等の参考値）。
 *   - 年金（selfPensionAnnual, spousePensionAnnual）: ÷deflator する＝
 *     名目額固定で実質目減りする仮定（日本の年金は概ね固定）。
 * 給与のみ昇給仮定なのは利便性のためで、毎年シート更新せずに長期予測した時に
 * 過小評価しないようにするため。この前提はドキュメント §4.1 に明記する。
 * 【§4.1a 分配金課税】総リターン nominalYield のうち分配（配当）として毎年実現
 * する分 dividendYield に、口座種別で非対称な税ドラッグを引く。
 *   - 課税(特定)口座分 (1−nisaRatio): 国内 20.315%（外国分は外国税額控除で
 *     外国源泉を回収でき≒国内税率に収束するので国内率のみで近似）。
 *   - NISA 口座分 nisaRatio: 国内は非課税だが外国源泉(米株≒10%)は回収不可で残る。
 *     分配のうち外国源泉割合 foreignDivShare ぶんに FOREIGN_DIV_WHT を課す。
 * 値上がり益は売却まで非課税繰延なのでドラッグ対象外。実効名目を
 * nominalYield − 分配×[(1−nisaRatio)×0.20315 + nisaRatio×foreignDivShare×0.10]
 * として rm を一本化し、青(期末資産)・橙(I列)・前進シミュすべてに同一 rm を
 * 効かせる（整合維持）。分配 0、または NISA 比率 100%×外国源泉 0% でドラッグ 0
 * ＝従来の総リターン1本モデルに一致（後方互換）。
 * FIRE可能時期は「その月に退職した場合、年金のみ・退職後支出・一時金なしで
 * 前進シミュした終了年齢資産が fireTargetRemain 以上になる最初の月」。
 * I列の意味（到達＝その月に辞めれば成立）と厳密に一致し、就労プランの
 * E列が FIRE後に I列を割り込んでも（＝そのまま働き続けてから退職予定日に
 * 辞めた場合の軌道が落ちても）「その月に辞める」判断とは無関係なので
 * FIRE可能時期は揺らがない。verdict も同一の前進シミュ（fireEndAssets）で
 * 判定するので両者は常に整合する。これにより engine はレガシー GAS シミュとは
 * 設計上意図的に乖離する（engine が唯一の正・GAS シミュは撤去対象）。
 */

/**
 * 上場株式等の配当・譲渡益にかかる国内税率（所得税15%＋復興2.1%＋住民5%）。
 * NISA（非課税口座）はこの国内課税が非課税。
 */
const DOMESTIC_DIV_TAX = 0.20315;

/**
 * 外国源泉徴収税率（米株配当に対する日米租税条約の標準税率 ≒10%）。
 * 特定口座なら外国税額控除で概ね取り戻せるが、NISA は控除すべき国内税が無いため
 * 回収不能で恒久ドラッグになる（§4.1a）。米株 ETF・米株比率の高い投信を NISA で
 * 持つほど効く。簡略化として一律 10%（実際は二重課税ファンド等で増減しうる）。
 */
const FOREIGN_DIV_WHT = 0.1;

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
  /**
   * 任意。総リターン（nominalYield）のうち分配金（配当）として毎年実現する
   * 利回り（資産に対する割合、例 0.03＝3%）。未指定/0 なら税ドラッグなし＝
   * 従来の総リターン1本モデルと完全一致。課税口座にある分配だけが
   * 20.315% 課税され実効リターンを押し下げる（§4.1a）。
   */
  dividendYield?: number;
  /**
   * 任意。分配金のうち NISA（非課税口座）で受け取る割合（0..1）。式上は
   * (1−nisaRatio) ぶんだけ国内課税ドラッグがかかる。分配は特定銘柄に偏在し
   * DC 年金など分配ゼロの資産もあるため、「資産のうち NISA 割合」ではなく
   * 「分配のうち NISA 割合」で与えるのが正確（drag を分配額ベースで効かせる）。
   * 未指定なら 0（全額が課税口座での受取＝最も保守的）。実値は保有明細と
   * 口座種別から設定する（MF ポートフォリオ画面には口座種別が出ないため手入力）。
   */
  nisaRatio?: number;
  /**
   * 任意。分配金のうち外国源泉（米株配当など）の割合（0..1）。NISA 口座分の分配は
   * 国内非課税だが外国源泉税（≒10%）は回収できず恒久ドラッグになる（§4.1a）。
   * その外国源泉ぶんを効かせる係数。未指定なら 0＝外国源泉ドラッグなし（後方互換）。
   * 米株 ETF・米株比率の高い投信を多く持つほど大きい（実値は保有明細から設定）。
   */
  foreignDivShare?: number;
  fireSolidThreshold: number;
  fireComfortThreshold: number;
  fireTargetAge: number;
  fireTargetRemain: number;
  simEndAge: number;
  /** 本人 */
  selfBirth: string;
  selfRetireDate: string;
  /**
   * 任意。指定時は selfRetireDate より優先し、退職を「本人が誕生月に
   * この年齢になる月」で定義する（UI スライダー用・年金開始年齢と同流儀）。
   * 未指定なら従来どおり selfRetireDate を使う（既存挙動・後方互換）。
   * シート読み込み時は selfRetireDate から defaultRetireAge() で既定値を補う。
   */
  selfRetireAge?: number;
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
   * 「その月に退職した場合、年金のみ・退職後支出・一時金なしで前進シミュした
   * 終了年齢資産が fireTargetRemain 以上になる最初の月」("YYYY/MM")。
   * ＝その月に辞めれば目標年齢まで持つ＝FIRE可能時期。null＝到達せず。
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
  /** 本人の退職月 "YYYY/MM"（UI の分配金カバー率など表示用アンカー）。 */
  retireYm: string;
  /** 退職月の期末資産（退職時の概算ネストエッグ）。UI 表示用。 */
  assetsAtRetire: number;
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

/**
 * selfRetireDate（＋本人誕生日）から UI スライダー既定の退職年齢を導く。
 * simulate の年齢パス `monthIndex(birth.y+age, birth.m)` の逆写像。
 *
 * 誕生月＝退職日の月の通常ケース（実シート値: 1977/03 生・2037/03 退職 等）は
 * 厳密一致＝ずれ 0 月。誕生月と退職日の月がずれている場合は Math.floor で
 * 「早めの退職」へ丸める＝最大 11ヶ月の前倒し（FIRE 評価は保守側に倒れる）。
 * Math.round だと半年で挙動が反転して両方向にずれるが、Math.floor なら常に
 * 単調（早期側）で UI スライダー操作の予測可能性が高い。
 */
export function defaultRetireAge(
  selfBirthIso: string,
  selfRetireDateIso: string,
): number {
  const b = parseYmd(selfBirthIso);
  const r = parseYmd(selfRetireDateIso);
  return Math.floor(
    (monthIndex(r.y, r.m) - monthIndex(b.y, b.m)) / 12,
  );
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
  // selfRetireAge 指定時は「誕生月にその年齢になる月」を退職月（＝最終就労月）
  // とする。未指定なら従来どおり selfRetireDate の月。defaultRetireAge() が
  // この写像の逆（日付→既定年齢）で、誕生月＝退職日月の通常ケースは厳密一致。
  const selfRetireIdx =
    p.selfRetireAge != null
      ? monthIndex(selfBirth.y + p.selfRetireAge, selfBirth.m)
      : monthIndex(selfRetire.y, selfRetire.m);
  const spouseRetireIdx = monthIndex(spouseRetire.y, spouseRetire.m);
  const loanEndIdx = monthIndex(loanEnd.y, loanEnd.m);
  const childEndIdx = monthIndex(childEnd.y, childEnd.m);

  // 分配金課税ドラッグ（§4.1a）。総リターン nominalYield のうち分配として毎年
  // 実現する分（dividendYield）に、口座種別で非対称な税を引く。課税(特定)口座分
  // (1−nisaRatio) は国内 20.315%、NISA 口座分 nisaRatio は国内非課税だが外国源泉
  // (米株≒10%)が回収不能で残る（分配のうち外国源泉割合 foreignDivShare ぶん）。
  // 値上がり益は売却まで非課税繰延なのでドラッグ対象外。分配 0、または
  // NISA100%×外国源泉0% でドラッグ 0＝従来の総リターン1本モデルと一致（後方互換）。
  const dividendYield = p.dividendYield ?? 0;
  const nisaRatio = Math.min(Math.max(p.nisaRatio ?? 0, 0), 1);
  const foreignDivShare = Math.min(Math.max(p.foreignDivShare ?? 0, 0), 1);
  const taxableDrag = dividendYield * (1 - nisaRatio) * DOMESTIC_DIV_TAX;
  const nisaForeignDrag =
    dividendYield * nisaRatio * foreignDivShare * FOREIGN_DIV_WHT;
  const effectiveNominal = p.nominalYield - taxableDrag - nisaForeignDrag;

  // フィッシャー方程式: 年実質 → 月実質
  const rYear = (1 + effectiveNominal) / (1 + p.inflation) - 1;
  const rm = Math.pow(1 + rYear, 1 / 12) - 1;

  // ホライズン: 本人が max(終了年齢, FIRE目標年齢) に達する月まで
  const maxAge = Math.max(p.simEndAge, p.fireTargetAge);
  const endIdx = monthIndex(selfBirth.y + maxAge, selfBirth.m);
  const totalMonths = Math.max(endIdx - startIdx + 1, 1);

  const rows: SimMonth[] = [];
  // 年金実質は I列逆算でも使うので別途保持
  const pensionRealArr: number[] = [];
  // I列用「退職済み前提」の支出。就労プランの expense とは系列が別（退職後
  // 社会保険料を当月以降ずっと計上）だが、インフレの扱いは E列と同じ
  // 「実質固定」（÷deflator しない）。年金のみ名目固定（pensionReal で÷deflator）。
  const retiredExpenseArr: number[] = [];
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
    // 依存のまま）。インフレ前提は E列（就労プランの expense）と統一し、支出は
    // 実質固定＝÷deflator しない（生活費は購買力一定。名目固定で実質目減りさせ
    // ない）。これにより青(期末資産)と橙(I列)が同一の動学になり整合する。
    const retiredExpense =
      p.baseLivingMonthly +
      (idx <= loanEndIdx ? p.loanMonthly : 0) +
      (idx <= childEndIdx ? p.childSupportMonthly : 0) +
      p.postRetireInsuranceMonthly;
    retiredExpenseArr.push(retiredExpense);
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
      (retiredExpenseArr[t] ?? 0);
    row.fireNeed = need;
    nextReq = need;
  }

  // --- 派生指標 ---
  // 終了年齢アンカー（本人が simEndAge に達する最初の月、無ければ最終行）
  let anchor = totalMonths - 1;
  for (let t = 0; t < totalMonths; t++) {
    if ((ageSelfArr[t] ?? -1) >= p.simEndAge) {
      anchor = t;
      break;
    }
  }

  // 就労プラン（リタイア予定日まで就労）で期末資産が初めて負になる月（参考・透明性）
  let depletionMonth: string | null = null;
  for (let t = 0; t < totalMonths; t++) {
    const r = rows[t];
    if (r === undefined) continue;
    if (r.endAssets < 0) {
      depletionMonth = r.ym;
      break;
    }
  }

  // 「その月に退職した場合」の前進シミュ（年金のみ・退職後支出・一時金なし）。
  // 各月の期首資産から anchor まで回し、終了年齢時点の資産を返す。
  // I列（FIRE必要資産）の意味と一致する評価軸＝この値が fireTargetRemain 以上
  // なら、その月に辞めて年金のみで目標年齢まで持つ。
  const retireSurvivalEnd = (fromIdx: number): number => {
    let a = rows[fromIdx]?.openAssets ?? p.currentAssets;
    for (let t = fromIdx; t <= anchor; t++) {
      const inc = pensionRealArr[t] ?? 0;
      const exp = retiredExpenseArr[t] ?? 0;
      a = (a + inc - exp) * (1 + rm);
    }
    return a;
  };

  // FIRE可能時期 = その前進シミュが fireTargetRemain 以上になる最初の月。
  // 就労プランの E列がこの後 I列を割り込んでも（働き続けて退職予定日に辞めた
  // 場合の軌道の話なので）「その月に辞める」判断とは無関係。初接触で確定する。
  // `r.fireNeed === null` の月（＝ageSelf > fireTargetAge）は探索対象から除く：
  // 目標年齢を超えてから初めて条件を満たすケースは「目標年齢までに FIRE 可能」
  // という指標の意味から外れるため、fireDate は null（未達）扱いとする。
  let fireDate: string | null = null;
  let ageAtFire: number | null = null;
  let fireIdx = -1;
  for (let t = 0; t < totalMonths; t++) {
    const r = rows[t];
    if (r === undefined || r.fireNeed === null) continue;
    if (retireSurvivalEnd(t) >= p.fireTargetRemain) {
      fireDate = r.ym;
      ageAtFire = r.ageSelf;
      fireIdx = t;
      break;
    }
  }

  // 就労プラン（リタイア予定日まで就労）の終了年齢時点資産（参考・透明性）
  const endAssetsAtSimEnd = rows[anchor]?.endAssets ?? 0;

  // fireDate に退職した場合の終了年齢資産。verdict をこれで判定することで
  // FIRE可能時期と必ず整合する（同一の前進シミュ）。
  const fireEndAssets: number | null =
    fireIdx >= 0 ? retireSurvivalEnd(fireIdx) : null;

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

  // 退職時アンカー（UI の分配金カバー率表示用）。selfRetireIdx の月の期末資産＝
  // 退職時の概算ネストエッグ。範囲外（過去に退職/ホライズン超過）は端にクランプ。
  // エンジンを唯一の正とし、template 側で退職月を再計算しない（重複・ドリフト防止）。
  const retireT = Math.min(Math.max(selfRetireIdx - startIdx, 0), totalMonths - 1);
  const assetsAtRetire = rows[retireT]?.endAssets ?? p.currentAssets;
  const retireYm = ymLabel(selfRetireIdx);

  return {
    monthly: rows,
    fireDate,
    ageAtFire,
    depletionMonth,
    endAssetsAtSimEnd,
    fireEndAssets,
    verdict,
    retireYm,
    assetsAtRetire,
  };
}
