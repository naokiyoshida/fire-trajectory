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

  it("hashTransactionId differs when any field changes", () => {
    const a = hashTransactionId(sample);
    const b = hashTransactionId({ ...sample, amount: "-501" });
    expect(a).not.toBe(b);
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
