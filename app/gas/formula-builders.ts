/**
 * GAS（src/gas_receiver_service.gs）が生成する数式の「正準仕様」。
 *
 * GAS は Apps Script ランタイム専用で tsc/vitest から import できないため、
 * シミュレーションの肝になる純粋な数式ビルダーをここに型付きで再実装し、
 * tests/gas/formula-builders.test.ts でスナップショット＋契約テストする。
 *
 * 重要: ここを変更したら src/gas_receiver_service.gs 側の対応箇所も必ず合わせること。
 * 契約テストが .gs のテンプレ文字列と本モジュールの整合を検証し、ドリフトを検出する。
 */

/** 数式内でシート名を 'シート名' 形式に引用（GAS: quoteSheetName_）。 */
export function quoteSheetNameForFormula(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/**
 * 「設定」シートの値を行番号ではなく項目名で参照（GAS: dashLookup_）。
 * 例: dashLookup("'設定'", "基本生活費_月額")
 *   → INDEX('設定'!$B:$B, MATCH("基本生活費_月額", '設定'!$A:$A, 0))
 */
export function dashLookup(dashRef: string, key: string): string {
  return `INDEX(${dashRef}!$B:$B, MATCH("${key}", ${dashRef}!$A:$A, 0))`;
}

/**
 * 実質割戻し係数。年金・退職一時金は将来名目額入力なので、経過 i ヶ月ぶん
 * インフレで割り戻して「今日の円（実質）」に揃える。
 *   realDeflator("設定!$B$..", 24) → (1+設定!$B$..)^(24/12)
 */
export function realDeflator(inflationRef: string, monthsElapsed: number): string {
  return `(1+${inflationRef})^(${monthsElapsed}/12)`;
}

/** 年金の月次収入（開始月以降に名目年額/12 を実質割戻しして計上）。 */
export function pensionIncomeFormula(args: {
  dateRef: string;
  startRef: string;
  pensionAnnualRef: string;
  deflator: string;
}): string {
  const { dateRef, startRef, pensionAnnualRef, deflator } = args;
  return `IF(${dateRef} >= ${startRef}, (${pensionAnnualRef}/12)/${deflator}, 0)`;
}

/** 退職一時金（対象月のみ、名目額を実質割戻しして一括計上）。 */
export function lumpIncomeFormula(args: {
  dateRef: string;
  eventDateRef: string;
  lumpRef: string;
  deflator: string;
}): string {
  const { dateRef, eventDateRef, lumpRef, deflator } = args;
  return `IF(TEXT(${dateRef},"yyyyMM")=TEXT(${eventDateRef},"yyyyMM"), ${lumpRef}/${deflator}, 0)`;
}

/**
 * FIRE必要資産ライン（I列）の1セル数式（GAS: fireNeed）。
 * I(r) = nextReq/(1+実質月利) − 年金(r) + 支出(r)、目標年齢超は ""。
 */
export function fireNeedFormula(args: {
  rowIdx: number;
  ageCol: string; // 例 "B"
  targetAgeRef: string; // dashLookup(...)
  nextReq: string; // 末尾は目標残額ref、それ以外は "I{rowIdx+1}" を含む式
  yieldCol: string; // 例 "G"
  niExpr: string; // 年金合計式（実質割戻し済み、カッコ込み）
  expenseExpr: string; // 実質割戻し済みの支出項（例: "(E5/(1+INF)^(5/12))"）
}): string {
  const { rowIdx, ageCol, targetAgeRef, nextReq, yieldCol, niExpr, expenseExpr } =
    args;
  return `=IF(${ageCol}${rowIdx} > ${targetAgeRef}, "", (${nextReq})/(1+${yieldCol}${rowIdx}) - ${niExpr} + ${expenseExpr})`;
}

/**
 * I列逆算の「数値版」。GAS の fireNeed セル数式と同一の算術を行う純粋関数で、
 * 符号ミス・係数ミス・割り算の分母誤りを数値で回帰検出するために使う。
 *   I(r) = nextReq/(1+月次実質利回り) − 年金(r) + 実質支出(r)
 */
export function fireNeedValue(args: {
  nextReq: number;
  monthlyRealYield: number;
  pensionReal: number;
  expenseReal: number;
}): number {
  const { nextReq, monthlyRealYield, pensionReal, expenseReal } = args;
  return nextReq / (1 + monthlyRealYield) - pensionReal + expenseReal;
}

/**
 * 2026-05 家計入金モデル化で廃止し、新デフォルトで上書きする旧設定キー。
 * 既存値の保持は項目名キーで突き合わせるため並び替えには非依存。
 */
export const LEGACY_DISCARDED_DASHBOARD_KEYS: readonly string[] = [
  "本人手取り月収",
  "配偶者年収_年額",
];
