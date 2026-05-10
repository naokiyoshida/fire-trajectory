import { launchBrowser } from "../core/browser.js";
import { loadConfig, requireSheetsConfig } from "../core/config.js";
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
import { TransactionSchema, type Transaction } from "../scrapers/transactions/schema.js";
import { dedupeById, toTransaction } from "../scrapers/transactions/transformer.js";

export const DATABASE_SHEET_NAME = "Database";
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

  let sheets: SheetsClient | null = null;
  let existingIds = new Set<string>();

  if (dryRun) {
    logger.info("Dry run: Sheets I/O is skipped");
  } else {
    const sheetsConfig = requireSheetsConfig(config);
    sheets = await createSheetsClient(
      sheetsConfig.sheetId,
      sheetsConfig.serviceAccountJson,
    );
    await ensureSheet(sheets, DATABASE_SHEET_NAME, DATABASE_HEADERS);
    existingIds = new Set(await readColumnValues(sheets, DATABASE_SHEET_NAME, "A"));
    logger.info(
      `Loaded ${existingIds.size} existing transaction IDs from ${DATABASE_SHEET_NAME}`,
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

  const all: Transaction[] = [];
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
      const txs: Transaction[] = [];
      for (const raw of raws) {
        const tx = toTransaction(raw);
        const validated = TransactionSchema.safeParse(tx);
        if (validated.success) {
          txs.push(validated.data);
        } else {
          logger.warn("Dropping transaction failing schema validation", {
            tx,
            issues: validated.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`),
          });
        }
      }
      logger.info(`Month ${year}/${month}: ${txs.length} valid transactions`);
      all.push(...txs);

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

  const unique = dedupeById(all);
  const fresh = unique.filter((t) => !existingIds.has(t.id));
  logger.info(
    `Aggregated: scraped=${all.length}, unique=${unique.length}, new=${fresh.length}`,
  );

  let appendedCount = 0;
  if (dryRun) {
    const sample = unique.slice(0, 3);
    logger.info(`Dry run: would append ${unique.length} transactions. Sample (up to 3):`);
    for (const t of sample) {
      logger.info(
        `  ${t.date} | ${t.content} | ${t.amount} | ${t.source} | ${t.category}`,
      );
    }
  } else if (fresh.length > 0 && sheets) {
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
