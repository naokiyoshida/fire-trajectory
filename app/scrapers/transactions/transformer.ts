import { createHash } from "node:crypto";
import type { RawTransaction, Transaction } from "./schema.js";

export function hashTransactionId(raw: RawTransaction): string {
  const uniqueString = `${raw.date}-${raw.content}-${raw.amount}-${raw.source}-${raw.category}`;
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
