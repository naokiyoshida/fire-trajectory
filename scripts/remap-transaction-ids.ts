/**
 * 取引履歴シートの ID 列を、現行の hashTransactionId（category 非依存 +
 * occurrence-index）で一括再計算する一度きりの移行スクリプト。
 *
 * 背景: 旧ハッシュは category を含んでいたため、Money Forward ME 側で
 * カテゴリを編集すると同一取引が別 ID になり二重追記されていた。新方式は
 * 自然キー `日付・内容・金額・口座` ＋ 同一自然キー内の出現順 occurrence で
 * ID を決める。occurrence は「シート追記順（＝元のスクレイプ順）」から決定的に
 * 復元できるため、同日・同額・同口座の別取引（例: 同日 ¥10,000 ATM 出金×2）も
 * 別 ID として保持されつつ、次回 sync での二重追記も防げる。
 *
 * 既存行の古い ID を新方式へ振り直さないと、次回 sync で取得した同じ取引が
 * 新 ID と一致せず再び二重追記される。これを一度だけ実行して解消する。
 *
 * 使い方:
 *   npm run remap-ids -- --dry-run   # 変更件数だけ確認（書き込まない）
 *   npm run remap-ids                # 実際に ID 列を書き換える
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig, requireSheetsConfig } from "../app/core/config.js";
import { createSheetsClient, quoteSheetName } from "../app/core/sheets-client.js";
import { DATABASE_SHEET_NAME } from "../app/pipeline/sync-transactions.js";
import {
  hashTransactionId,
  transactionKey,
} from "../app/scrapers/transactions/transformer.js";

loadDotenv();

// 取引履歴の列順: A=ID, B=日付, C=内容, D=金額, E=保有金融機関, F=大項目/中項目, G=取得日時
const COL = { id: 0, date: 1, content: 2, amount: 3, source: 4, category: 5 } as const;

interface RowInfo {
  sheetRow: number;
  occ: number;
  category: string;
  fetchedAt: string;
}

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
  // 自然キーごとの出現回数（シート追記順で 0,1,2… を採番）
  const occByKey = new Map<string, number>();
  // 自然キーごとの行情報（occurrence で区別された複数取引の可視化用）
  const keyGroups = new Map<string, { date: string; content: string; amount: string; source: string; rows: RowInfo[] }>();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const cell = (i: number): string => String(row[i] ?? "");
    const date = cell(COL.date);
    const content = cell(COL.content);
    const amount = cell(COL.amount);
    const source = cell(COL.source);

    // 完全な空行（自然キー素材が全て空）は ID を触らず現状維持して整列を保つ
    if (!date && !content && !amount && !source) {
      newIdColumn.push([cell(COL.id)]);
      blankSkipped += 1;
      continue;
    }

    const raw = { date, content, amount, source, category: cell(COL.category) };
    const key = transactionKey(raw);
    const occ = occByKey.get(key) ?? 0;
    occByKey.set(key, occ + 1);

    const oldId = cell(COL.id);
    const newId = hashTransactionId(raw, occ);
    newIdColumn.push([newId]);

    const g = keyGroups.get(key) ?? { date, content, amount, source, rows: [] };
    g.rows.push({
      sheetRow: r + 2,
      occ,
      category: cell(COL.category),
      fetchedAt: cell(6),
    });
    keyGroups.set(key, g);

    if (newId !== oldId) {
      changed += 1;
      if (sample.length < 5) {
        sample.push(
          `  ${date} | ${content} | ${amount} | ${source} [occ=${occ}]\n    ${oldId.slice(0, 12)}… → ${newId.slice(0, 12)}…`,
        );
      }
    }
  }

  const sharedKeyGroups = [...keyGroups.values()].filter(
    (g) => g.rows.length > 1,
  );
  const sharedRows = sharedKeyGroups.reduce((s, g) => s + g.rows.length, 0);

  console.log(`再計算で ID が変わる行: ${changed} / ${rows.length}`);
  console.log(`空行（ID 据え置き）: ${blankSkipped}`);
  if (sample.length > 0) {
    console.log("\n変更サンプル (最大5件):");
    console.log(sample.join("\n"));
  }
  if (sharedKeyGroups.length > 0) {
    console.log(
      `\nℹ 同一の自然キー(日付・内容・金額・口座)を持つ取引が ${sharedRows} 行（${sharedKeyGroups.length} グループ）あります。`,
    );
    console.log(
      "  occurrence(0,1,2…) で別 ID に分離済みです。これらは同日・同額・同口座の",
    );
    console.log(
      "  別取引として両方保持されます。削除は不要です（取得日時/categoryは参考表示）。",
    );
    console.log("\n=== 同一自然キー・グループ（occurrence で区別） ===");
    let gi = 0;
    for (const g of sharedKeyGroups) {
      gi += 1;
      console.log(`\n[${gi}] ${g.date} | ${g.content} | ${g.amount} | ${g.source}`);
      for (const m of [...g.rows].sort((a, b) => a.sheetRow - b.sheetRow)) {
        console.log(
          `    行${m.sheetRow} occ=${m.occ} 取得日時=${m.fetchedAt || "(空)"} category=${m.category || "(空)"}`,
        );
      }
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
  console.log(
    `\n${DATABASE_SHEET_NAME}!A2:A${lastRow} の ID を更新しました（${changed} 行変更）。`,
  );
}

main().catch((err: unknown) => {
  console.error("remap-transaction-ids failed:", err);
  process.exit(1);
});
