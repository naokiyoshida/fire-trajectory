/**
 * 取引履歴シートの指定行を生値でダンプする読み取り専用の点検スクリプト。
 * セル内の改行・余計な空白を可視化するため各値を JSON.stringify して出す。
 *
 * 使い方:
 *   npm run dev -- ...（CLI には載せない一時保守用）
 *   npx tsx scripts/inspect-rows.ts 4446 4447   # 中心となるシート行番号を指定
 * 引数なしなら 4446 4447 を中心に前後を表示。
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig, requireSheetsConfig } from "../app/core/config.js";
import { createSheetsClient, quoteSheetName } from "../app/core/sheets-client.js";
import { DATABASE_SHEET_NAME } from "../app/pipeline/sync-transactions.js";

loadDotenv();

const HEADERS = ["ID", "日付", "内容", "金額", "保有金融機関", "大項目/中項目", "取得日時"];

async function scan(): Promise<void> {
  const cfg = requireSheetsConfig(loadConfig());
  const client = await createSheetsClient(cfg.sheetId, cfg.serviceAccountJson);
  const sheet = quoteSheetName(DATABASE_SHEET_NAME);
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: cfg.sheetId,
    range: `${sheet}!A2:G`,
  });
  const rows = (res.data.values ?? []) as string[][];

  let newlineCount = 0;
  let integreCount = 0;
  const distinct = new Map<string, number>();
  for (const row of rows) {
    const src = String(row[4] ?? "");
    const bad = src.includes("\n") || src.includes("インテグレ");
    if (src.includes("\n")) newlineCount++;
    if (src.includes("インテグレ")) integreCount++;
    if (bad) distinct.set(src, (distinct.get(src) ?? 0) + 1);
  }
  console.log(`総データ行: ${rows.length}`);
  console.log(`保有金融機関に改行を含む行: ${newlineCount}`);
  console.log(`保有金融機関に「インテグレ」を含む行: ${integreCount}`);
  console.log(`異常な保有金融機関の種類 (${distinct.size}):`);
  for (const [k, n] of [...distinct.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(5)} 件: ${JSON.stringify(k)}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--scan")) {
    await scan();
    return;
  }
  const targets = process.argv.slice(2).map((s) => parseInt(s, 10)).filter(Number.isFinite);
  const centers = targets.length > 0 ? targets : [4446, 4447];
  const lo = Math.min(...centers) - 2;
  const hi = Math.max(...centers) + 2;

  const cfg = requireSheetsConfig(loadConfig());
  const client = await createSheetsClient(cfg.sheetId, cfg.serviceAccountJson);
  const sheet = quoteSheetName(DATABASE_SHEET_NAME);

  // シート行番号でそのまま範囲取得（ヘッダは行1）。
  const range = `${sheet}!A${lo}:G${hi}`;
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: cfg.sheetId,
    range,
  });
  const rows = (res.data.values ?? []) as string[][];

  console.log(`=== ${DATABASE_SHEET_NAME} ${range} ===`);
  for (let i = 0; i < rows.length; i++) {
    const sheetRow = lo + i;
    const row = rows[i] ?? [];
    const mark = centers.includes(sheetRow) ? " <<<" : "";
    console.log(`--- 行 ${sheetRow}${mark} ---`);
    for (let c = 0; c < HEADERS.length; c++) {
      console.log(`  ${HEADERS[c]}: ${JSON.stringify(row[c] ?? "")}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
