/**
 * 取引履歴シートの「再追記による重複行」を安全に解消する保守スクリプト。
 *
 * 背景: ハッシュ方式を変更すると既存行の ID は旧方式のまま残るため、次回
 * `npm run sync` が同じ取引を新 ID で再追記し、同期窓（直近 SYNC_MONTHS ヶ月）
 * が二重になる。旧方式の「シート値から ID 再計算」は、過去フル同期が金額を
 * ¥付き表現で保存しているなど表現差で現行スクレイパ出力と一致せず破綻した。
 *
 * 本スクリプトは ID を一切いじらず、行の素性で重複を解消する:
 *   - 正規化自然キー = 日付 / 内容 / 金額(¥,円 空白除去) / 保有金融機関
 *   - 同一キーに「取得日時(G列)」が複数種あれば、それは同じ取引を別 run で
 *     再追記した重複 → 最新の取得日時の行だけ残し、古い run の行を削除する。
 *   - 同一 run（取得日時が同じ）の同一キー複数行は、同日・同額・同口座の
 *     別取引（occurrence で別 ID 済み）なので保持する。
 *
 * 使い方:
 *   npm run dedupe-rows -- --dry-run   # 削除対象の確認のみ
 *   npm run dedupe-rows                # 実削除
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig, requireSheetsConfig } from "../app/core/config.js";
import { createSheetsClient, quoteSheetName } from "../app/core/sheets-client.js";
import { DATABASE_SHEET_NAME } from "../app/pipeline/sync-transactions.js";
import { rowNaturalKey } from "../app/pipeline/transaction-rows.js";

loadDotenv();

// 自然キー正規化は doctor と共有（app/pipeline/transaction-rows.ts）。
const keyOf = rowNaturalKey;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = requireSheetsConfig(loadConfig());
  const client = await createSheetsClient(cfg.sheetId, cfg.serviceAccountJson);
  const sheet = quoteSheetName(DATABASE_SHEET_NAME);

  const meta = await client.api.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const sheetId = (meta.data.sheets ?? []).find(
    (s) => s.properties?.title === DATABASE_SHEET_NAME,
  )?.properties?.sheetId;
  if (sheetId == null) throw new Error(`${DATABASE_SHEET_NAME} sheetId not found`);

  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: cfg.sheetId,
    range: `${sheet}!A2:G`,
  });
  const V = (res.data.values ?? []) as string[][];
  const total = V.length;

  // 自然キーごとに、出現した取得日時の集合と各行を集める
  const groups = new Map<
    string,
    { fetchedSet: Set<string>; rows: { sr: number; g: string; row: string[] }[] }
  >();
  for (let i = 0; i < total; i++) {
    const row = V[i] ?? [];
    if (!row[1] && !row[2] && !row[3] && !row[4]) continue; // 空行
    const k = keyOf(row);
    const g = String(row[6] ?? "");
    const e = groups.get(k) ?? { fetchedSet: new Set<string>(), rows: [] };
    e.fetchedSet.add(g);
    e.rows.push({ sr: i + 2, g, row });
    groups.set(k, e);
  }

  const toDelete: number[] = [];
  const sample: string[] = [];
  for (const e of groups.values()) {
    if (e.fetchedSet.size < 2) continue; // 単一 run のみ → 重複ではない
    const latest = [...e.fetchedSet].sort().at(-1)!; // ISO 文字列なので辞書順=時系列
    for (const m of e.rows) {
      if (m.g !== latest) {
        toDelete.push(m.sr);
        if (sample.length < 8)
          sample.push(
            `  行${m.sr} ${String(m.row[1])} | ${String(m.row[2])} | ${String(m.row[3])} | ${String(m.row[4])} (G=${m.g} → 最新 ${latest} を残す)`,
          );
      }
    }
  }

  console.log(`総行=${total} / 重複(旧 run)削除対象=${toDelete.length}`);
  if (sample.length) {
    console.log("削除対象サンプル(最大8):");
    console.log(sample.join("\n"));
  }

  if (dryRun) {
    console.log("\n[dry-run] 削除しません。");
    return;
  }
  if (toDelete.length === 0) {
    console.log("\n削除対象なし。");
    return;
  }

  toDelete.sort((a, b) => b - a); // 降順で1行ずつ削除しインデックスずれ防止
  const requests = toDelete.map((sr) => ({
    deleteDimension: {
      range: { sheetId, dimension: "ROWS" as const, startIndex: sr - 1, endIndex: sr },
    },
  }));
  for (let i = 0; i < requests.length; i += 500) {
    await client.api.spreadsheets.batchUpdate({
      spreadsheetId: cfg.sheetId,
      requestBody: { requests: requests.slice(i, i + 500) },
    });
  }
  console.log(`\n${toDelete.length} 行を削除しました。`);
}

main().catch((e: unknown) => {
  console.error("dedupe-transaction-rows failed:", e);
  process.exit(1);
});
