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

  interface RowInfo {
    sheetRow: number;
    date: string;
    content: string;
    amount: string;
    source: string;
    category: string;
    fetchedAt: string; // G列 取得日時。run ごとに固定値なので由来判定に使う
  }
  const newIdColumn: string[][] = [];
  let changed = 0;
  let blankSkipped = 0;
  const sample: string[] = [];
  const newIdRows = new Map<string, RowInfo[]>();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
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
    const group = newIdRows.get(newId) ?? [];
    group.push({
      sheetRow: r + 2,
      date,
      content,
      amount,
      source,
      category: cell(COL.category),
      fetchedAt: cell(6),
    });
    newIdRows.set(newId, group);
    if (newId !== oldId) {
      changed += 1;
      if (sample.length < 5) {
        sample.push(
          `  ${date} | ${content} | ${amount} | ${source}\n    ${oldId.slice(0, 12)}… → ${newId.slice(0, 12)}…`,
        );
      }
    }
  }

  const dupGroups = [...newIdRows.values()].filter((g) => g.length > 1);
  const dupRows = dupGroups.reduce((s, g) => s + (g.length - 1), 0);

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
      "  ID 振り直し自体は安全です。ただし重複行は自動削除しません（誤って実取引を消さないため）。",
    );
    console.log(
      "  由来は取得日時(G列)で判別できます: run ごとに固定値なので —",
    );
    console.log(
      "    ・取得日時が【異なる】 → 別 run での再追記＝二重追記。新しい取得日時の行を削除。",
    );
    console.log(
      "    ・取得日時が【同一】 → 同一 run で MF が別取引として返した（category 違い等）＝",
    );
    console.log(
      "      実取引の可能性が高い。原則どちらも残す（消すと実支出が欠落）。",
    );
    console.log("\n=== 重複グループ（取引履歴シートの行番号つき） ===");
    let gi = 0;
    for (const g of dupGroups) {
      gi += 1;
      const h = g[0]!;
      const allSameFetched = g.every((m) => m.fetchedAt === h.fetchedAt);
      const verdict = allSameFetched
        ? "同一 run 取得 → 実取引の可能性。原則どちらも保持"
        : "取得日時が混在 → 再追記の疑い。新しい取得日時の行を削除候補";
      console.log(
        `\n[${gi}] ${h.date} | ${h.content} | ${h.amount} | ${h.source}`,
      );
      for (const m of [...g].sort((a, b) => a.sheetRow - b.sheetRow)) {
        console.log(
          `    行${m.sheetRow} 取得日時=${m.fetchedAt || "(空)"} category=${m.category || "(空)"}`,
        );
      }
      console.log(`    判定: ${verdict}`);
    }
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
