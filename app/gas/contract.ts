/**
 * GAS（src/gas_receiver_service.gs）と Node 側で共有する「契約」の正準仕様。
 *
 * GAS は Apps Script ランタイム専用で tsc/vitest から import できないため、
 * .gs に残るヘルパ（quoteSheetName_ / dashLookup_）と旧キー移行を型付きで
 * 再実装し、tests/gas/contract.test.ts が .gs のテンプレ文字列と本モジュール
 * の整合を検証してドリフトを検出する。
 *
 * シミュレーション数式は engine.ts が唯一の正（§4.3）。GAS シミュは撤去済み
 * （§4.5）なので、ここに数式ビルダーは持たない。fireNeedValue だけは I列
 * 算術の独立な再実装として engine.test.ts の同一性アンカーに使う。
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
 * I列逆算の「数値版」。engine.ts の I列セル算術と同一の純粋関数で、
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
