/**
 * `npm run doctor`: 取引履歴シートの健全性を1回で診断する恒久コマンド。
 *
 * 使い捨て診断スクリプトを都度書く代わりに、以下を一括出力する:
 *   1. 総行数
 *   2. A列の重複ID（あってはならない）＋サンプル
 *   3. 「旧 run 重複」（同一自然キーで取得日時が複数 = dedupe-rows 対象）
 *   4. 最新 run 行の「保存ID vs 現行 transformer 再計算ID」一致率
 *      ← remap-ids 級の方式不整合をこの1指標で即検知
 *   5. 最終 sync ステータス＋健全性判定（evaluateHealth 再利用）
 *
 * 異常（重複IDあり / 最新 run の不一致あり）なら exit code を非0にする。
 */
import { config as loadDotenv } from "dotenv";
import { loadConfig, requireSheetsConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import { createSheetsClient, quoteSheetName } from "../core/sheets-client.js";
import { evaluateHealth, readSyncStatus } from "../core/sync-status.js";
import {
  hashTransactionId,
  transactionKey,
} from "../scrapers/transactions/transformer.js";
import { DATABASE_SHEET_NAME } from "./sync-transactions.js";
import { COL, isEmptyRow, rowNaturalKey } from "./transaction-rows.js";

export interface TransactionDiagnosis {
  total: number;
  /** A列が重複しているID種別数 / 影響行数 / サンプル */
  duplicateIdGroups: number;
  duplicateIdRows: number;
  duplicateIdSample: string[];
  /** 同一自然キーで取得日時が複数 = 旧 run 由来の重複行数 / サンプル */
  oldRunDuplicateRows: number;
  oldRunDuplicateSample: string[];
  /** 最新 run（最大取得日時）の検証 */
  latestFetchedAt: string | null;
  latestRunRows: number;
  latestRunIdMatches: number;
  latestRunIdMismatches: number;
  latestRunMismatchSample: string[];
}

/**
 * 純粋関数: 生の行配列からシート診断を算出する（I/Oなし・単体テスト可能）。
 * 最新 run の再計算は「シート出現順に自然キーごと occurrence 採番」で行い、
 * 現行 transformer が同じIDを再現できるか（= 次回 sync が正しく dedup するか）
 * を検証する。過去 run の旧式行は方式が違って当然なので対象にしない。
 */
export function analyzeTransactionRows(
  rows: string[][],
): TransactionDiagnosis {
  const data = rows.filter((r) => !isEmptyRow(r));
  const total = data.length;

  // 2. A列の重複ID
  const idCount = new Map<string, number>();
  for (const r of data) {
    const id = String(r[COL.id] ?? "");
    if (id) idCount.set(id, (idCount.get(id) ?? 0) + 1);
  }
  let duplicateIdGroups = 0;
  let duplicateIdRows = 0;
  const duplicateIdSample: string[] = [];
  for (const [id, c] of idCount) {
    if (c > 1) {
      duplicateIdGroups++;
      duplicateIdRows += c;
      if (duplicateIdSample.length < 5)
        duplicateIdSample.push(`${id.slice(0, 12)}… ×${c}`);
    }
  }

  // 3. 旧 run 重複（同一自然キーで取得日時が2種以上 → 古い run 側が重複）
  const byKey = new Map<string, Set<string>>();
  for (const r of data) {
    const k = rowNaturalKey(r);
    const set = byKey.get(k) ?? new Set<string>();
    set.add(String(r[COL.fetchedAt] ?? ""));
    byKey.set(k, set);
  }
  let oldRunDuplicateRows = 0;
  const oldRunDuplicateSample: string[] = [];
  for (const r of data) {
    const k = rowNaturalKey(r);
    const tsSet = byKey.get(k);
    if (!tsSet || tsSet.size < 2) continue;
    const latest = [...tsSet].sort().at(-1);
    if (String(r[COL.fetchedAt] ?? "") !== latest) {
      oldRunDuplicateRows++;
      if (oldRunDuplicateSample.length < 5)
        oldRunDuplicateSample.push(
          `${String(r[COL.date])} | ${String(r[COL.content])} | ${String(
            r[COL.amount],
          )} | ${String(r[COL.source])}`,
        );
    }
  }

  // 4. 最新 run の保存ID vs 現行 transformer 再計算ID
  let latestFetchedAt: string | null = null;
  for (const r of data) {
    const ts = String(r[COL.fetchedAt] ?? "");
    if (ts && (latestFetchedAt === null || ts > latestFetchedAt))
      latestFetchedAt = ts;
  }
  let latestRunRows = 0;
  let latestRunIdMatches = 0;
  let latestRunIdMismatches = 0;
  const latestRunMismatchSample: string[] = [];
  if (latestFetchedAt !== null) {
    const seen = new Map<string, number>();
    for (const r of data) {
      if (String(r[COL.fetchedAt] ?? "") !== latestFetchedAt) continue;
      const raw = {
        date: String(r[COL.date] ?? ""),
        content: String(r[COL.content] ?? ""),
        amount: String(r[COL.amount] ?? ""),
        source: String(r[COL.source] ?? ""),
        category: String(r[COL.category] ?? ""),
      };
      const key = transactionKey(raw);
      const occ = seen.get(key) ?? 0;
      seen.set(key, occ + 1);
      const expected = hashTransactionId(raw, occ);
      latestRunRows++;
      if (expected === String(r[COL.id] ?? "")) {
        latestRunIdMatches++;
      } else {
        latestRunIdMismatches++;
        if (latestRunMismatchSample.length < 5)
          latestRunMismatchSample.push(
            `${raw.date} | ${raw.content} | ${raw.amount} | ${raw.source} ` +
              `(保存=${String(r[COL.id] ?? "").slice(0, 12)}… 期待=${expected.slice(
                0,
                12,
              )}…)`,
          );
      }
    }
  }

  return {
    total,
    duplicateIdGroups,
    duplicateIdRows,
    duplicateIdSample,
    oldRunDuplicateRows,
    oldRunDuplicateSample,
    latestFetchedAt,
    latestRunRows,
    latestRunIdMatches,
    latestRunIdMismatches,
    latestRunMismatchSample,
  };
}

/** 診断結果から CLI 終了コードを決める（異常なら非0）。 */
export function diagnosisExitCode(d: TransactionDiagnosis): number {
  if (d.duplicateIdRows > 0) return 4;
  if (d.latestRunRows > 0 && d.latestRunIdMismatches > 0) return 5;
  return 0;
}

/** I/O ラッパ: シートを読み取り（書き込みなし）診断を表示し exit code を返す。 */
export async function runDoctor(): Promise<number> {
  loadDotenv();
  const cfg = requireSheetsConfig(loadConfig());
  const client = await createSheetsClient(cfg.sheetId, cfg.serviceAccountJson);
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: cfg.sheetId,
    range: `${quoteSheetName(DATABASE_SHEET_NAME)}!A2:G`,
  });
  const rows = (res.data.values ?? []) as string[][];
  const d = analyzeTransactionRows(rows);

  logger.info("===== doctor: 取引履歴シート診断 =====");
  logger.info(`総行数: ${d.total}`);
  logger.info(
    `A列重複ID: ${d.duplicateIdGroups} 種 / ${d.duplicateIdRows} 行` +
      (d.duplicateIdSample.length
        ? ` 例: ${d.duplicateIdSample.join(", ")}`
        : ""),
  );
  logger.info(
    `旧 run 重複(dedupe-rows 対象): ${d.oldRunDuplicateRows} 行` +
      (d.oldRunDuplicateSample.length
        ? `\n  例:\n  - ${d.oldRunDuplicateSample.join("\n  - ")}`
        : ""),
  );
  if (d.latestRunRows > 0) {
    const rate = Math.round(
      (d.latestRunIdMatches / d.latestRunRows) * 100,
    );
    logger.info(
      `最新 run (${d.latestFetchedAt}) ID 整合: ` +
        `${d.latestRunIdMatches}/${d.latestRunRows} 一致 (${rate}%)`,
    );
    if (d.latestRunIdMismatches > 0)
      logger.error(
        `最新 run に ${d.latestRunIdMismatches} 件の不一致（次回 sync が二重追記する恐れ）:\n  - ` +
          d.latestRunMismatchSample.join("\n  - "),
      );
  } else {
    logger.info("最新 run の判定対象行なし。");
  }

  const verdict = evaluateHealth(readSyncStatus(), new Date());
  logger.info(`health: ${verdict.message}`);

  const code = diagnosisExitCode(d);
  if (code === 0) {
    logger.info("診断: 異常なし。次回 sync は正しく重複排除されます。");
  } else {
    logger.error(
      `診断: 異常あり (exit=${code})。dedupe-rows / 再 sync を検討してください（DEPLOY_GUIDE §8.6）。`,
    );
  }
  return code;
}
