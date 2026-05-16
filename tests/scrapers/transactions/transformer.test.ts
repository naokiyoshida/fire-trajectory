import { describe, expect, it } from "vitest";
import {
  dedupeById,
  hashTransactionId,
  toTransaction,
  toTransactions,
  transactionKey,
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
    expect(hashTransactionId(sample)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashTransactionId is deterministic for identical inputs", () => {
    expect(hashTransactionId(sample)).toBe(hashTransactionId({ ...sample }));
  });

  it("transactionKey excludes category (= date-content-amount-source)", () => {
    expect(transactionKey(sample)).toBe(
      "2026/05/01-コンビニ--500-三井住友カード",
    );
    expect(transactionKey(sample)).toBe(
      transactionKey({ ...sample, category: "別カテゴリ" }),
    );
  });

  it("hashTransactionId is unchanged when only category changes", () => {
    // category をハッシュに含めると、MF でのカテゴリ修正のたびに別IDになり
    // 同一取引が二重追記される。category 変更で ID 不変を契約として固定する。
    expect(hashTransactionId({ ...sample, category: "趣味・娯楽/書籍" })).toBe(
      hashTransactionId(sample),
    );
  });

  it("hashTransactionId differs when a hash-relevant field changes", () => {
    const a = hashTransactionId(sample);
    expect(hashTransactionId({ ...sample, amount: "-501" })).not.toBe(a);
    expect(hashTransactionId({ ...sample, date: "2026/05/02" })).not.toBe(a);
    expect(hashTransactionId({ ...sample, content: "スーパー" })).not.toBe(a);
    expect(hashTransactionId({ ...sample, source: "楽天カード" })).not.toBe(a);
  });

  it("occurrence index disambiguates same-key transactions", () => {
    // 同日・同額・同口座・同内容の別取引（例: 同日に同額 ATM 出金を2回）は
    // occurrence で別IDになる。0番は既定値と一致する。
    expect(hashTransactionId(sample, 0)).toBe(hashTransactionId(sample));
    expect(hashTransactionId(sample, 1)).not.toBe(hashTransactionId(sample, 0));
    expect(hashTransactionId(sample, 1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("toTransactions assigns occurrence so same-key rows get distinct ids", () => {
    const [a, b] = toTransactions([sample, { ...sample }]);
    expect(a!.id).not.toBe(b!.id);
    expect(a!.id).toBe(hashTransactionId(sample, 0));
    expect(b!.id).toBe(hashTransactionId(sample, 1));
    // 真に別取引なので重複排除では消えない
    expect(dedupeById([a!, b!])).toHaveLength(2);
  });

  it("toTransactions is order-deterministic", () => {
    const input = [sample, { ...sample, content: "別" }, { ...sample }];
    const a = toTransactions(input).map((t) => t.id);
    const b = toTransactions(input).map((t) => t.id);
    expect(a).toEqual(b);
  });

  it("toTransaction equals toTransactions single (occurrence 0)", () => {
    expect(toTransaction(sample).id).toBe(toTransactions([sample])[0]!.id);
  });

  it("dedupeById removes only exact id duplicates", () => {
    const t = toTransaction(sample);
    expect(dedupeById([t, { ...t }, t])).toHaveLength(1);
  });
});
