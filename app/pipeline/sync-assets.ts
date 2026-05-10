import { launchBrowser } from "../core/browser.js";
import { loadConfig, requireSheetsConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import {
  appendRows,
  createSheetsClient,
  ensureSheet,
  quoteSheetName,
  readColumnValues,
  type SheetsClient,
} from "../core/sheets-client.js";
import { extractAssets, extractLiabilities } from "../scrapers/assets/extractor.js";
import {
  navigateToAssetsPage,
  navigateToLiabilitiesPage,
} from "../scrapers/assets/navigator.js";
import {
  AssetSnapshotSchema,
  ManualAssetsSchema,
  ScrapedAssetSnapshotSchema,
  type ManualAssets,
} from "../scrapers/assets/schema.js";
import { buildAssetSnapshot } from "../scrapers/assets/transformer.js";

export const ASSETS_SHEET_NAME = "資産推移";

// 資産推移シートのヘッダー（表示は日本語、内部キーとの対応は ASSETS_KEY_ORDER に定義）
export const ASSETS_HEADERS: string[] = [
  "基準日",
  "預金・現金",
  "株式（現物）",
  "株式（未上場）",
  "投資信託",
  "年金",
  "ポイント",
  "その他資産",
  "資産総額",
  "クレジット未払",
  "住宅ローン",
  "その他負債",
  "負債総額",
  "純資産",
  "備考",
];

// AssetSnapshot の内部キーを日本語ヘッダーと同じ順序で並べたもの
// （列順とヘッダー数を一致させるための単一情報源）
export const ASSETS_KEY_ORDER: string[] = [
  "snapshot_date",
  "cash",
  "stocks_listed",
  "stocks_unlisted",
  "funds",
  "pension",
  "points",
  "other_assets",
  "total_assets",
  "credit_card",
  "mortgage",
  "other_loans",
  "total_liabilities",
  "net_worth",
  "notes",
];

export const MANUAL_ASSETS_SHEET_NAME = "手動入力資産";
export const MANUAL_ASSETS_HEADERS = ["項目", "値", "備考"];

// 手動入力資産シートの「項目」列に書く日本語ラベル → 内部キー
const MANUAL_LABEL_TO_KEY: Record<string, "stocks_unlisted" | "notes"> = {
  "未上場株式": "stocks_unlisted",
  "備考": "notes",
};

export interface SyncAssetsOptions {
  dryRun?: boolean;
}

export interface SyncAssetsResult {
  scraped: boolean;
  appended: boolean;
  skipped: boolean;
  reason?: string;
  dryRun: boolean;
}

export function todayJstYmd(now: Date = new Date()): string {
  const tokyo = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = tokyo.getFullYear();
  const m = String(tokyo.getMonth() + 1).padStart(2, "0");
  const d = String(tokyo.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function loadManualAssets(sheets: SheetsClient): Promise<ManualAssets> {
  const range = `${quoteSheetName(MANUAL_ASSETS_SHEET_NAME)}!A2:C`;
  const res = await sheets.api.spreadsheets.values.get({
    spreadsheetId: sheets.spreadsheetId,
    range,
  });
  const rows = (res.data.values ?? []) as string[][];
  // 「項目」列に日本語ラベルを書いてもらい、内部では英字キーで保持する
  const map: Record<string, string> = {};
  for (const r of rows) {
    const label = r[0];
    if (typeof label !== "string" || label.length === 0) continue;
    const key = MANUAL_LABEL_TO_KEY[label];
    if (!key) continue;
    map[key] = r[1] ?? "";
  }

  const rawValue = map.stocks_unlisted ?? "";
  const cleaned = rawValue.replace(/[,円\s]/g, "");
  const parsed = parseInt(cleaned, 10);

  return ManualAssetsSchema.parse({
    stocks_unlisted: Number.isFinite(parsed) ? parsed : 0,
    notes: map.notes ?? "",
  });
}

export async function syncAssets(
  options: SyncAssetsOptions = {},
): Promise<SyncAssetsResult> {
  const config = loadConfig();
  const dryRun = options.dryRun ?? false;
  const snapshotDate = todayJstYmd();
  const currentYm = snapshotDate.slice(0, 7);

  let sheets: SheetsClient | null = null;
  let manual: ManualAssets = ManualAssetsSchema.parse({});

  if (dryRun) {
    logger.info("Dry run: Sheets I/O skipped");
  } else {
    const sheetsConfig = requireSheetsConfig(config);
    sheets = await createSheetsClient(
      sheetsConfig.sheetId,
      sheetsConfig.serviceAccountJson,
    );
    await ensureSheet(sheets, ASSETS_SHEET_NAME, ASSETS_HEADERS);
    await ensureSheet(sheets, MANUAL_ASSETS_SHEET_NAME, MANUAL_ASSETS_HEADERS);

    const existingDates = await readColumnValues(sheets, ASSETS_SHEET_NAME, "A");
    const alreadyHasMonth = existingDates.some((d) => d.startsWith(currentYm));
    if (alreadyHasMonth) {
      logger.info(
        `Skipping: ${ASSETS_SHEET_NAME} already has an entry for ${currentYm}`,
      );
      return {
        scraped: false,
        appended: false,
        skipped: true,
        reason: "current_month_already_recorded",
        dryRun: false,
      };
    }

    manual = await loadManualAssets(sheets);
    logger.info(
      `${MANUAL_ASSETS_SHEET_NAME} loaded: stocks_unlisted=${manual.stocks_unlisted}, notes="${manual.notes}"`,
    );
  }

  const headless = process.env.HEADLESS !== "false";
  const browser = await launchBrowser({
    storageStatePath: config.STORAGE_STATE_PATH,
    headless,
  });

  try {
    await navigateToAssetsPage(browser.page, config.MF_ASSETS_URL);
    const scrapedAssets = await extractAssets(browser.page);

    await navigateToLiabilitiesPage(browser.page, config.MF_ASSETS_URL);
    const scrapedLiabilities = await extractLiabilities(browser.page);

    const scrapedAll = ScrapedAssetSnapshotSchema.parse({
      ...scrapedAssets,
      ...scrapedLiabilities,
    });

    const snapshot = buildAssetSnapshot(scrapedAll, manual, snapshotDate);
    AssetSnapshotSchema.parse(snapshot);

    if (dryRun) {
      logger.info("Dry run: would append asset snapshot:");
      for (const [k, v] of Object.entries(snapshot)) {
        logger.info(`  ${k}: ${typeof v === "number" ? v.toLocaleString() : v}`);
      }
      return { scraped: true, appended: false, skipped: false, dryRun: true };
    }

    if (sheets) {
      const row = ASSETS_KEY_ORDER.map((k) => {
        const v = (snapshot as Record<string, unknown>)[k];
        return typeof v === "number" ? v : String(v ?? "");
      });
      await appendRows(sheets, ASSETS_SHEET_NAME, [row]);
      logger.info(`Appended asset snapshot for ${snapshotDate}`);
      return { scraped: true, appended: true, skipped: false, dryRun: false };
    }

    return { scraped: true, appended: false, skipped: false, dryRun: false };
  } finally {
    await browser.close();
  }
}
