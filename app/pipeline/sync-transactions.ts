import { launchBrowser } from "../core/browser.js";
import { loadConfig, requireSheetsConfig } from "../core/config.js";
import { ScrapingError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import {
  appendRows,
  createSheetsClient,
  ensureSheet,
  readColumnValues,
  type SheetsClient,
} from "../core/sheets-client.js";
import { extractTransactions } from "../scrapers/transactions/extractor.js";
import {
  clickPrevMonth,
  decrementMonth,
  navigateToMonth,
} from "../scrapers/transactions/navigator.js";
import {
  TransactionSchema,
  type RawTransaction,
  type Transaction,
} from "../scrapers/transactions/schema.js";
import { dedupeById, toTransactions } from "../scrapers/transactions/transformer.js";
import { assessAppendSafety } from "./append-guard.js";

export const DATABASE_SHEET_NAME = "取引履歴";
export const DATABASE_HEADERS = [
  "ID",
  "日付",
  "内容",
  "金額",
  "保有金融機関",
  "大項目/中項目",
  "取得日時",
];

export interface SyncTransactionsOptions {
  dryRun?: boolean;
  fullSync?: boolean;
  /** dry-run でも既存IDを読み、真の新規件数を出す（書き込みは一切しない）。 */
  peekExisting?: boolean;
  /** 追記前ガードを無視して強制追記する（正当な大量差分のとき）。 */
  forceAppend?: boolean;
}

export interface SyncTransactionsResult {
  scraped: number;
  unique: number;
  appended: number;
  dryRun: boolean;
  monthsScanned: number;
  fullMode: boolean;
}

export function computeMonthsToSync(args: {
  fullSync: boolean;
  databaseIsEmpty: boolean;
  fullSyncStart: string;
  defaultMonths: number;
  today?: Date;
}): { months: number; fullMode: boolean } {
  const { fullSync, databaseIsEmpty, fullSyncStart, defaultMonths } = args;
  const fullMode = fullSync || databaseIsEmpty;
  if (!fullMode) return { months: defaultMonths, fullMode: false };

  const parts = fullSyncStart.split("/");
  const startYear = parseInt(parts[0] ?? "", 10);
  const startMonth = parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(startYear) || !Number.isFinite(startMonth)) {
    return { months: defaultMonths, fullMode };
  }

  const today = args.today ?? new Date();
  const span =
    (today.getFullYear() - startYear) * 12 +
    (today.getMonth() + 1 - startMonth) +
    1;
  return { months: Math.max(span, defaultMonths), fullMode };
}

export async function syncTransactions(
  options: SyncTransactionsOptions = {},
): Promise<SyncTransactionsResult> {
  const config = loadConfig();
  const dryRun = options.dryRun ?? false;
  const fullSync = options.fullSync ?? false;
  const peekExisting = options.peekExisting ?? false;
  const forceAppend = options.forceAppend ?? false;
  // 既存IDを読むか: 通常実行は常に、dry-run は peek 指定時のみ（書き込みは別途禁止）。
  const loadExisting = !dryRun || peekExisting;

  let sheets: SheetsClient | null = null;
  let existingIds = new Set<string>();

  if (!loadExisting) {
    logger.info("Dry run: Sheets I/O is skipped");
  } else {
    const sheetsConfig = requireSheetsConfig(config);
    sheets = await createSheetsClient(
      sheetsConfig.sheetId,
      sheetsConfig.serviceAccountJson,
    );
    // peek は読み取り専用に徹する（ensureSheet はヘッダ未設定時に書き込むため除外）。
    if (!dryRun) {
      await ensureSheet(sheets, DATABASE_SHEET_NAME, DATABASE_HEADERS);
    }
    existingIds = new Set(await readColumnValues(sheets, DATABASE_SHEET_NAME, "A"));
    logger.info(
      `Loaded ${existingIds.size} existing transaction IDs from ${DATABASE_SHEET_NAME}` +
        (dryRun ? " (peek: 読み取り専用)" : ""),
    );
  }

  const { months: monthsToSync, fullMode } = computeMonthsToSync({
    fullSync,
    databaseIsEmpty: existingIds.size === 0,
    fullSyncStart: config.FULL_SYNC_START,
    defaultMonths: config.SYNC_MONTHS,
  });
  if (fullMode) {
    logger.info(
      `Full mode: scanning ${monthsToSync} months from ${config.FULL_SYNC_START}`,
    );
  } else {
    logger.info(`Incremental mode: scanning ${monthsToSync} months`);
  }

  const headless = process.env.HEADLESS !== "false";
  const browser = await launchBrowser({
    storageStatePath: config.STORAGE_STATE_PATH,
    headless,
  });

  // occurrence は自然キーごとに「取得した順」で採番する必要があるため、
  // 月をまたいで全 raw を取得し終えてから一括で ID を付与する。
  const allRaws: RawTransaction[] = [];
  const today = new Date();
  let year = today.getFullYear();
  let month = today.getMonth() + 1;

  try {
    await navigateToMonth(browser.page, {
      baseUrl: config.MF_TRANSACTIONS_URL,
      year,
      month,
    });

    for (let i = 0; i < monthsToSync; i++) {
      const raws = await extractTransactions(browser.page, year, month);
      logger.info(`Month ${year}/${month}: ${raws.length} transactions`);
      allRaws.push(...raws);

      if (i < monthsToSync - 1) {
        const next = decrementMonth(year, month);
        await clickPrevMonth(browser.page, next.year, next.month);
        year = next.year;
        month = next.month;
      }
    }
  } finally {
    await browser.close();
  }

  // 自然キー内の出現順で occurrence を採番して ID を確定（同日・同額・同口座の
  // 別取引も別IDになり保持される）。その後スキーマ検証で異常行を落とす。
  const all: Transaction[] = [];
  for (const tx of toTransactions(allRaws)) {
    const validated = TransactionSchema.safeParse(tx);
    if (validated.success) {
      all.push(validated.data);
    } else {
      logger.warn("Dropping transaction failing schema validation", {
        tx,
        issues: validated.error.issues.map(
          (iss) => `${iss.path.join(".")}: ${iss.message}`,
        ),
      });
    }
  }

  // この家計で全走査月の取引が 0 件になることは実質ありえない。
  // セッション失効（/sign_in リダイレクト）や DOM 変更を「正常終了」として
  // ゼロ書き込みのまま月を閉じないよう、ここで明示的に失敗させて通知経路に乗せる。
  if (all.length === 0) {
    throw new ScrapingError(
      `${monthsToSync}ヶ月走査したが取引が1件も取得できませんでした。` +
        `セッション失効（要 npm run login）か Money Forward の画面変更の可能性が高いです。`,
      "extractor",
      { monthsToSync, fullMode },
    );
  }

  const unique = dedupeById(all);
  const fresh = unique.filter((t) => !existingIds.has(t.id));
  logger.info(
    `Aggregated: scraped=${all.length}, unique=${unique.length}, new=${fresh.length}`,
  );

  let appendedCount = 0;
  if (dryRun) {
    const target = peekExisting ? fresh : unique;
    logger.info(
      peekExisting
        ? `Dry run (peek): 既存 ${existingIds.size} 件と照合 → 真の新規 ${fresh.length} 件。Sample (up to 3):`
        : `Dry run: would append ${unique.length} transactions（既存未照合）. Sample (up to 3):`,
    );
    for (const t of target.slice(0, 3)) {
      logger.info(
        `  ${t.date} | ${t.content} | ${t.amount} | ${t.source} | ${t.category}`,
      );
    }
  } else if (fresh.length > 0 && sheets) {
    const guard = assessAppendSafety({
      fullMode,
      hadExistingIds: existingIds.size > 0,
      uniqueCount: unique.length,
      freshCount: fresh.length,
    });
    if (!guard.safe && !forceAppend) {
      throw new ScrapingError(`追記前ガード中止: ${guard.message}`, "sink", {
        uniqueCount: unique.length,
        freshCount: fresh.length,
        ratio: guard.ratio,
      });
    }
    if (!guard.safe) {
      logger.warn(`追記前ガード警告（--force で続行）: ${guard.message}`);
    }
    const now = new Date().toISOString();
    const rows = fresh.map((t) => [
      t.id,
      t.date,
      t.content,
      t.amount,
      t.source,
      t.category,
      now,
    ]);
    await appendRows(sheets, DATABASE_SHEET_NAME, rows);
    appendedCount = fresh.length;
    logger.info(`Appended ${fresh.length} new transactions to ${DATABASE_SHEET_NAME}`);
  }

  return {
    scraped: all.length,
    unique: unique.length,
    appended: appendedCount,
    dryRun,
    monthsScanned: monthsToSync,
    fullMode,
  };
}
