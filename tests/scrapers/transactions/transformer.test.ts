import { describe, expect, it } from "vitest";
import {
  dedupeById,
  hashTransactionId,
  toTransaction,
} from "../../../app/scrapers/transactions/transformer.js";
import type { RawTransaction } from "../../../app/scrapers/transactions/schema.js";

const sample: RawTransaction = {
  date: "2026/05/01",
  content: "コンビニ",
  amount: "-500",
  source: "三井住友カード",
  category: "食費/食料品",
};

describe("transactions/transformer", () => {
  it("hashTransactionId produces a 64-char hex string", () => {
    const id = hashTransactionId(sample);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashTransactionId is deterministic for identical inputs", () => {
    expect(hashTransactionId(sample)).toBe(hashTransactionId({ ...sample }));
  });

  it("hashTransactionId is unchanged when only category changes", () => {
    // Money Forward ME はカテゴリを後から編集できる。category をハッシュに
    // 含めると、カテゴリ修正のたびに別IDになり同一取引が二重追記される。
    // → category 変更では ID が変わらないことを契約として固定する。
    const a = hashTransactionId(sample);
    const b = hashTransactionId({ ...sample, category: "趣味・娯楽/書籍" });
    expect(a).toBe(b);
  });

  it("hashTransactionId differs when a hash-relevant field changes", () => {
    const a = hashTransactionId(sample);
    expect(hashTransactionId({ ...sample, amount: "-501" })).not.toBe(a);
    expect(hashTransactionId({ ...sample, date: "2026/05/02" })).not.toBe(a);
    expect(hashTransactionId({ ...sample, content: "スーパー" })).not.toBe(a);
    expect(hashTransactionId({ ...sample, source: "楽天カード" })).not.toBe(a);
  });

  it("toTransaction attaches the id", () => {
    const t = toTransaction(sample);
    expect(t.id).toMatch(/^[0-9a-f]{64}$/);
    expect(t.content).toBe(sample.content);
  });

  it("dedupeById removes duplicates", () => {
    const t = toTransaction(sample);
    const result = dedupeById([t, { ...t }, t]);
    expect(result).toHaveLength(1);
  });
});
