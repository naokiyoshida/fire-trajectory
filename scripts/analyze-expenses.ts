import { config as loadDotenv } from "dotenv";
import { loadConfig, requireSheetsConfig } from "../app/core/config.js";
import { createSheetsClient, quoteSheetName } from "../app/core/sheets-client.js";

loadDotenv();

interface MonthAgg {
  totalExpense: number;
  totalIncome: number;
  byCategory: Record<string, number>;
  count: number;
}

function fmtYen(n: number): string {
  return "¥" + Math.round(n).toLocaleString();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sheetsConfig = requireSheetsConfig(config);
  const client = await createSheetsClient(
    sheetsConfig.sheetId,
    sheetsConfig.serviceAccountJson,
  );

  const sheetName = "取引履歴";
  const range = `${quoteSheetName(sheetName)}!A2:G`;
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: sheetsConfig.sheetId,
    range,
  });
  const rows = (res.data.values ?? []) as string[][];
  console.log(`Loaded ${rows.length} transactions from 取引履歴\n`);

  const months: Record<string, MonthAgg> = {};
  const allCategorySum: Record<string, number> = {};
  let earliest = "9999/99";
  let latest = "0000/00";

  for (const row of rows) {
    const date = String(row[1] ?? "");
    const amountStr = String(row[3] ?? "");
    const category = String(row[5] ?? "(未分類)");
    const m = date.match(/^(\d{4})\/(\d{1,2})/);
    if (!m) continue;
    const ymKey = `${m[1]}/${m[2]?.padStart(2, "0")}`;
    if (ymKey < earliest) earliest = ymKey;
    if (ymKey > latest) latest = ymKey;

    const amount = Number(String(amountStr).replace(/[,¥]/g, ""));
    if (!Number.isFinite(amount)) continue;

    const agg = months[ymKey] ?? {
      totalExpense: 0,
      totalIncome: 0,
      byCategory: {},
      count: 0,
    };
    agg.count += 1;
    if (amount < 0) {
      const abs = -amount;
      agg.totalExpense += abs;
      agg.byCategory[category] = (agg.byCategory[category] ?? 0) + abs;
      allCategorySum[category] = (allCategorySum[category] ?? 0) + abs;
    } else {
      agg.totalIncome += amount;
    }
    months[ymKey] = agg;
  }

  const sortedMonths = Object.keys(months).sort();
  console.log(`期間: ${earliest} 〜 ${latest} (${sortedMonths.length}ヶ月)\n`);

  console.log("=== 月次支出 (直近24ヶ月) ===");
  for (const ym of sortedMonths.slice(-24)) {
    const m = months[ym]!;
    console.log(
      `${ym}: 支出 ${fmtYen(m.totalExpense).padStart(12)} / 収入 ${fmtYen(m.totalIncome).padStart(12)} (取引 ${m.count}件)`,
    );
  }

  // 平均 (直近12ヶ月, 直近24ヶ月, 全期間) — 直近月は途中のため除外
  const lastComplete = sortedMonths.slice(0, -1);
  const last12 = lastComplete.slice(-12);
  const last24 = lastComplete.slice(-24);
  const avgOf = (ms: string[]): number =>
    ms.length === 0 ? 0 : ms.reduce((s, k) => s + months[k]!.totalExpense, 0) / ms.length;

  console.log("\n=== 月次支出 平均 (途中月を除外) ===");
  console.log(`直近12ヶ月平均: ${fmtYen(avgOf(last12))}`);
  console.log(`直近24ヶ月平均: ${fmtYen(avgOf(last24))}`);
  console.log(`全期間平均:     ${fmtYen(avgOf(lastComplete))}`);

  // カテゴリ別合計 (上位30) — どんな大項目があるか把握
  console.log("\n=== カテゴリ別合計支出 (上位30, 全期間) ===");
  const catSorted = Object.entries(allCategorySum).sort((a, b) => b[1] - a[1]);
  let totalAll = 0;
  for (const [, v] of catSorted) totalAll += v;
  for (const [cat, sum] of catSorted.slice(0, 30)) {
    const pct = ((sum / totalAll) * 100).toFixed(1);
    console.log(`${cat.padEnd(40)} ${fmtYen(sum).padStart(14)} (${pct}%)`);
  }

  // 住宅ローン / 教育・養育 / 仕送り 関連を抽出して控除した「基本生活費」相当の推計
  console.log("\n=== 基本生活費(月次) 推計 ===");
  console.log("(控除対象: カテゴリに 住宅/ローン/教育/養育/仕送り を含むもの)");
  const excludePattern = /住宅|ローン|教育|養育|仕送り/;
  const excluded: Record<string, number> = {};
  for (const [cat, sum] of Object.entries(allCategorySum)) {
    if (excludePattern.test(cat)) excluded[cat] = sum;
  }
  console.log("控除カテゴリ:");
  for (const [cat, sum] of Object.entries(excluded).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${cat}: ${fmtYen(sum)}`);
  }

  const basicLastN = (ms: string[]): number => {
    if (ms.length === 0) return 0;
    let total = 0;
    for (const ym of ms) {
      const agg = months[ym]!;
      let monthBasic = agg.totalExpense;
      for (const [cat, v] of Object.entries(agg.byCategory)) {
        if (excludePattern.test(cat)) monthBasic -= v;
      }
      total += monthBasic;
    }
    return total / ms.length;
  };

  console.log("\n基本生活費(控除後) 月次平均:");
  console.log(`  直近12ヶ月: ${fmtYen(basicLastN(last12))}`);
  console.log(`  直近24ヶ月: ${fmtYen(basicLastN(last24))}`);
  console.log(`  全期間:     ${fmtYen(basicLastN(lastComplete))}`);
}

main().catch((err: unknown) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
