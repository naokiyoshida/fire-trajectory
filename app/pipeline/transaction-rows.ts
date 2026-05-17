/**
 * 取引履歴シートの「生の行配列(string[])」を扱う共有ヘルパ。
 * dedupe-rows と doctor で重複定義しないよう、自然キー正規化をここに集約する。
 */

/** 取引履歴シートの列インデックス（0 始まり）。 */
export const COL = {
  id: 0,
  date: 1,
  content: 2,
  amount: 3,
  source: 4,
  category: 5,
  fetchedAt: 6,
} as const;

/** 日付・内容・金額・口座がすべて空なら空行とみなす。 */
export function isEmptyRow(r: string[]): boolean {
  return !r[COL.date] && !r[COL.content] && !r[COL.amount] && !r[COL.source];
}

/**
 * 金額表記ゆれ吸収。過去フル同期は `¥20` / `-¥5,949` のような書式付きで
 * 保存されており、現行スクレイパの `-5949` と「同じ取引」を突き合わせるには
 * ¥・カンマ・「円」・空白を落として比較する必要がある。
 */
export function normalizeAmount(s: string): string {
  return s.replace(/[¥,円\s]/g, "");
}

/** ¥/カンマ差を吸収した重複判定用の自然キー（日付|内容|金額|口座）。 */
export function rowNaturalKey(r: string[]): string {
  return `${r[COL.date] ?? ""}|${r[COL.content] ?? ""}|${normalizeAmount(
    r[COL.amount] ?? "",
  )}|${r[COL.source] ?? ""}`;
}
