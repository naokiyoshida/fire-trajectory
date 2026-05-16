import { createHash } from "node:crypto";
import type { RawTransaction, Transaction } from "./schema.js";

// 自然キー = 日付・内容・金額・口座。category は含めない（Money Forward ME は
// カテゴリを後から編集でき、含めるとカテゴリ変更のたびに別IDになり同一取引が
// 二重追記されるため）。ただし自然キーだけでは「同日・同額・同口座・同内容の
// 別取引」（例: 同じ日に ¥10,000 の ATM 出金を2回）を区別できない。そこで
// 自然キーが衝突する取引には出現順 occurrence(0,1,2…) を付与してIDを分離する。
// occurrence は「スクレイプ時の MF 返却順」「移行時のシート追記順」のどちらでも
// 決定的に同じ値になるため、二重追記を防ぎつつ実取引の取りこぼしも防げる。
export function transactionKey(raw: RawTransaction): string {
  return `${raw.date}-${raw.content}-${raw.amount}-${raw.source}`;
}

export function hashTransactionId(raw: RawTransaction, occurrence = 0): string {
  const uniqueString = `${transactionKey(raw)}#${occurrence}`;
  return createHash("sha256").update(uniqueString).digest("hex");
}

/**
 * 取引配列に occurrence を採番して Transaction[] を返す。同一自然キーが
 * 入力順に 0,1,2… を受け取る。順序が決定的なら出力IDも決定的。
 */
export function toTransactions(raws: RawTransaction[]): Transaction[] {
  const seenCount = new Map<string, number>();
  const out: Transaction[] = [];
  for (const raw of raws) {
    const key = transactionKey(raw);
    const occ = seenCount.get(key) ?? 0;
    seenCount.set(key, occ + 1);
    out.push({ ...raw, id: hashTransactionId(raw, occ) });
  }
  return out;
}

/** 単一取引の変換（occurrence 0）。互換目的の薄いラッパ。 */
export function toTransaction(raw: RawTransaction): Transaction {
  return { ...raw, id: hashTransactionId(raw, 0) };
}

export function dedupeById(transactions: Transaction[]): Transaction[] {
  const seen = new Set<string>();
  return transactions.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
