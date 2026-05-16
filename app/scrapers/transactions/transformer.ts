import { createHash } from "node:crypto";
import type { RawTransaction, Transaction } from "./schema.js";

// ハッシュ入力に category は含めない。Money Forward ME はカテゴリを後から
// 編集できるため、含めるとカテゴリ変更のたびに別IDになり同一取引が二重追記される。
// 日付・内容・金額・口座の4点で実用上の一意性は十分（同一口座で同日・同店・同額が
// 別取引になるケースは MF が content を分けるためほぼ発生しない）。
export function hashTransactionId(raw: RawTransaction): string {
  const uniqueString = `${raw.date}-${raw.content}-${raw.amount}-${raw.source}`;
  return createHash("sha256").update(uniqueString).digest("hex");
}

export function toTransaction(raw: RawTransaction): Transaction {
  return { ...raw, id: hashTransactionId(raw) };
}

export function dedupeById(transactions: Transaction[]): Transaction[] {
  const seen = new Set<string>();
  return transactions.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
