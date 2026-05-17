import { describe, expect, it } from "vitest";
import {
  analyzeTransactionRows,
  diagnosisExitCode,
} from "../../app/pipeline/diagnose-transactions.js";
import { hashTransactionId } from "../../app/scrapers/transactions/transformer.js";

const LATEST = "2026-05-16T00:00:00.000Z";
const OLDER = "2026-05-10T00:00:00.000Z";

// 列: [id, 日付, 内容, 金額, 口座, カテゴリ, 取得日時]
function buildRows(): string[][] {
  const coffee = {
    date: "2026/05/16",
    content: "Coffee",
    amount: "-500",
    source: "Card",
    category: "食費/外食",
  };
  const rent = {
    date: "2026/05/01",
    content: "Rent",
    amount: "-80000",
    source: "Bank",
    category: "住宅/家賃",
  };
  return [
    // 最新 run・同一自然キーが occ0/occ1 で別ID（occurrence 検証・両方一致）
    [
      hashTransactionId(coffee, 0),
      coffee.date,
      coffee.content,
      coffee.amount,
      coffee.source,
      coffee.category,
      LATEST,
    ],
    [
      hashTransactionId(coffee, 1),
      coffee.date,
      coffee.content,
      coffee.amount,
      coffee.source,
      coffee.category,
      LATEST,
    ],
    // 最新 run だが保存IDが現行方式と不一致（remap-ids 級の検知対象）
    [
      "f".repeat(64),
      "2026/05/16",
      "Lunch",
      "-1200",
      "Card",
      "食費/外食",
      LATEST,
    ],
    // 旧 run の Rent（同一自然キーが latest にも居る → 旧側が dedupe-rows 対象）
    [
      "1".repeat(64),
      rent.date,
      rent.content,
      rent.amount,
      rent.source,
      rent.category,
      OLDER,
    ],
    // 最新 run の Rent（occ0・正しいID → 一致、こちらが残る側）
    [
      hashTransactionId(rent, 0),
      rent.date,
      rent.content,
      rent.amount,
      rent.source,
      rent.category,
      LATEST,
    ],
    // A列重複ID（あってはならない）。旧 ts にして最新 run 判定から除外
    ["a".repeat(64), "2026/05/05", "DupX", "-10", "Card", "雑費/その他", OLDER],
    ["a".repeat(64), "2026/05/06", "DupY", "-20", "Card", "雑費/その他", OLDER],
    // 空行（total から除外されること）
    ["", "", "", "", "", "", ""],
  ];
}

describe("analyzeTransactionRows", () => {
  const d = analyzeTransactionRows(buildRows());

  it("空行を除いた総行数", () => {
    expect(d.total).toBe(7);
  });

  it("A列の重複IDを検出", () => {
    expect(d.duplicateIdGroups).toBe(1);
    expect(d.duplicateIdRows).toBe(2);
    expect(d.duplicateIdSample[0]).toContain("×2");
  });

  it("旧 run 重複（取得日時が複数の自然キーの古い側）を検出", () => {
    expect(d.oldRunDuplicateRows).toBe(1);
    expect(d.oldRunDuplicateSample[0]).toContain("Rent");
  });

  it("最新 run = 最大取得日時", () => {
    expect(d.latestFetchedAt).toBe(LATEST);
    expect(d.latestRunRows).toBe(4);
  });

  it("occurrence を含め現行方式で再計算し一致/不一致を判定", () => {
    expect(d.latestRunIdMatches).toBe(3); // coffee occ0, coffee occ1, rent occ0
    expect(d.latestRunIdMismatches).toBe(1); // Lunch のダミーID
    expect(d.latestRunMismatchSample[0]).toContain("Lunch");
  });

  it("重複IDがあれば exit code 4", () => {
    expect(diagnosisExitCode(d)).toBe(4);
  });

  it("クリーンなシートは exit 0", () => {
    const clean = analyzeTransactionRows([
      [
        hashTransactionId(
          {
            date: "2026/05/16",
            content: "A",
            amount: "-1",
            source: "S",
            category: "C",
          },
          0,
        ),
        "2026/05/16",
        "A",
        "-1",
        "S",
        "C",
        LATEST,
      ],
    ]);
    expect(clean.duplicateIdRows).toBe(0);
    expect(clean.latestRunIdMismatches).toBe(0);
    expect(diagnosisExitCode(clean)).toBe(0);
  });
});
