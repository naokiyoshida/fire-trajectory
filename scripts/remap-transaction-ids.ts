/**
 * 取引履歴シートの ID 列を、現行の hashTransactionId（category 非依存）で
 * 一括再計算する一度きりの移行スクリプト。
 *
 * 背景: 以前のハッシュは category を含んでいたため、Money Forward ME 側で
 * カテゴリを編集すると同一取引が別 ID になり二重追記されていた。新ハッシュへ
 * 切り替えても「既存行の古い ID」は残るため、次回 sync で取得した同じ取引が
 * 新 ID と一致せず再び二重追記される。これを防ぐため既存行の ID を新方式で
 * 振り直す。
 *
 * 使い方:
 *   npm run remap-ids -- --dry-run   # 変更件数だけ確認（書き込まない）
 *   npm run remap-ids                # 実際に ID 列を書き換える
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig, requireSheetsConfig } from "../app/core/config.js";
import { createSheetsClient, quoteSheetName } from "../app/core/sheets-client.js";
import { DATABASE_SHEET_NAME } from "../app/pipeline/sync-transactions.js";
import { hashTransactionId } from "../app/scrapers/transactions/transformer.js";

loadDotenv();

// 取引履歴の列順: A=ID, B=日付, C=内容, D=金額, E=保有金融機関, F=大項目/中項目, G=取得日時
const COL = { id: 0, date: 1, content: 2, amount: 3, source: 4, category: 5 } as const;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const sheetsConfig = requireSheetsConfig(config);
  const client = await createSheetsClient(
    sheetsConfig.sheetId,
    sheetsConfig.serviceAccountJson,
  );

  const sheet = quoteSheetName(DATABASE_SHEET_NAME);
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: sheetsConfig.sheetId,
    range: `${sheet}!A2:G`,
  });
  const rows = (res.data.values ?? []) as string[][];
  console.log(`Loaded ${rows.length} rows from ${DATABASE_SHEET_NAME}\n`);

  const newIdColumn: string[][] = [];
  let changed = 0;
  let blankSkipped = 0;
  const sample: string[] = [];
  const newIdCount = new Map<string, number>();

  for (const row of rows) {
    const cell = (i: number): string => String(row[i] ?? "");
    const date = cell(COL.date);
    const content = cell(COL.content);
    const amount = cell(COL.amount);
    const source = cell(COL.source);

    // 完全な空行（ハッシュ素材が全て空）は ID を触らず現状維持して整列を保つ
    if (!date && !content && !amount && !source) {
      newIdColumn.push([cell(COL.id)]);
      blankSkipped += 1;
      continue;
    }

    const oldId = cell(COL.id);
    const newId = hashTransactionId({
      date,
      content,
      amount,
      source,
      category: cell(COL.category),
    });
    newIdColumn.push([newId]);
    newIdCount.set(newId, (newIdCount.get(newId) ?? 0) + 1);
    if (newId !== oldId) {
      changed += 1;
      if (sample.length < 5) {
        sample.push(
          `  ${date} | ${content} | ${amount} | ${source}\n    ${oldId.slice(0, 12)}… → ${newId.slice(0, 12)}…`,
        );
      }
    }
  }

  const dupGroups = [...newIdCount.values()].filter((n) => n > 1);
  const dupRows = dupGroups.reduce((s, n) => s + (n - 1), 0);

  console.log(`再計算で ID が変わる行: ${changed} / ${rows.length}`);
  console.log(`空行（ID 据え置き）: ${blankSkipped}`);
  if (sample.length > 0) {
    console.log("\n変更サンプル (最大5件):");
    console.log(sample.join("\n"));
  }
  if (dupRows > 0) {
    console.log(
      `\n⚠ 再計算後に同一 ID が重複する行が ${dupRows} 行あります（${dupGroups.length} グループ）。`,
    );
    console.log(
      "  これは category 編集で過去に二重追記された実際の重複です。ID 振り直し自体は安全ですが、",
    );
    console.log(
      "  重複行は自動削除されません。シート上で日付・内容・金額・口座が同一の行を目視で1行に整理してください。",
    );
  }

  if (dryRun) {
    console.log("\n[dry-run] 書き込みは行いません。");
    return;
  }
  if (changed === 0) {
    console.log("\n変更なし。書き込みをスキップしました。");
    return;
  }

  const lastRow = 1 + newIdColumn.length;
  await client.api.spreadsheets.values.update({
    spreadsheetId: sheetsConfig.sheetId,
    range: `${sheet}!A2:A${lastRow}`,
    valueInputOption: "RAW",
    requestBody: { values: newIdColumn },
  });
  console.log(`\n${DATABASE_SHEET_NAME}!A2:A${lastRow} の ID を更新しました（${changed} 行変更）。`);
}

main().catch((err: unknown) => {
  console.error("remap-transaction-ids failed:", err);
  process.exit(1);
});
