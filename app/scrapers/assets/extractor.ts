import type { Page } from "playwright";
import { ScrapingError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import {
  ScrapedAssetsSchema,
  ScrapedLiabilitiesSchema,
  type ScrapedAssets,
  type ScrapedLiabilities,
} from "./schema.js";
import { loadAssetsSelectors } from "./selectors.js";

interface ScrapedSummaryRow {
  label: string;
  amount: number;
}

interface ScrapedSummary {
  total: number;
  rows: ScrapedSummaryRow[];
}

export function parseJpyAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,円\s]/g, "");
  const m = cleaned.match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

async function scrapeSummary(page: Page): Promise<ScrapedSummary> {
  const sel = loadAssetsSelectors();

  // page.evaluate 内では関数宣言を使わない（tsx __name 問題回避）
  const summary = await page.evaluate(
    (s) => {
      // 総額ボックス
      let totalText = "";
      for (const sel of s.total_box) {
        const el = document.querySelector(sel);
        if (el) {
          totalText = (el.textContent ?? "").trim();
          break;
        }
      }

      // サマリーテーブル
      let table: Element | null = null;
      for (const sel of s.summary_table) {
        table = document.querySelector(sel);
        if (table) break;
      }
      const rows: { label: string; amountText: string }[] = [];
      if (table) {
        const trs = table.querySelectorAll(s.summary_row);
        for (const tr of Array.from(trs)) {
          const labelEl = tr.querySelector(s.summary_label);
          const tds = tr.querySelectorAll(s.summary_amount);
          if (!labelEl || tds.length === 0) continue;
          const label = (labelEl.textContent ?? "").trim();
          const amountText = (tds[0]?.textContent ?? "").trim();
          if (label) rows.push({ label, amountText });
        }
      }

      return { totalText, rows };
    },
    sel,
  );

  const total = parseJpyAmount(summary.totalText);
  if (total === null) {
    throw new ScrapingError("Could not parse total amount from heading box", "extractor", {
      raw: summary.totalText,
    });
  }

  const parsedRows: ScrapedSummaryRow[] = [];
  for (const r of summary.rows) {
    const amount = parseJpyAmount(r.amountText);
    if (amount === null) {
      logger.warn("Skipping summary row with unparsable amount", r);
      continue;
    }
    parsedRows.push({ label: r.label, amount });
  }

  return { total, rows: parsedRows };
}

function bucketBy(
  rows: ScrapedSummaryRow[],
  map: Record<string, string>,
  fallbackKey: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const unknown: ScrapedSummaryRow[] = [];
  for (const r of rows) {
    const key = map[r.label];
    if (key) {
      out[key] = (out[key] ?? 0) + r.amount;
    } else {
      unknown.push(r);
      out[fallbackKey] = (out[fallbackKey] ?? 0) + r.amount;
    }
  }
  if (unknown.length > 0) {
    logger.warn(
      `Found ${unknown.length} unmapped categories (bucketed into ${fallbackKey})`,
      { labels: unknown.map((u) => u.label) },
    );
  }
  return out;
}

export async function extractAssets(page: Page): Promise<ScrapedAssets> {
  const sel = loadAssetsSelectors();
  const summary = await scrapeSummary(page);
  const buckets = bucketBy(summary.rows, sel.asset_categories, "other_assets");

  const data = {
    cash: buckets.cash ?? 0,
    stocks_listed: buckets.stocks_listed ?? 0,
    funds: buckets.funds ?? 0,
    pension: buckets.pension ?? 0,
    points: buckets.points ?? 0,
    other_assets: buckets.other_assets ?? 0,
    total_assets_mf: summary.total,
  };

  logger.info(
    `Assets: cash=${data.cash}, stocks=${data.stocks_listed}, funds=${data.funds}, ` +
      `pension=${data.pension}, points=${data.points}, other=${data.other_assets}, ` +
      `total=${data.total_assets_mf}`,
  );

  return ScrapedAssetsSchema.parse(data);
}

export async function extractLiabilities(page: Page): Promise<ScrapedLiabilities> {
  const sel = loadAssetsSelectors();
  const summary = await scrapeSummary(page);
  const buckets = bucketBy(summary.rows, sel.liability_categories, "other_loans");

  const data = {
    credit_card: buckets.credit_card ?? 0,
    mortgage: buckets.mortgage ?? 0,
    other_loans: buckets.other_loans ?? 0,
    total_liabilities_mf: summary.total,
  };

  logger.info(
    `Liabilities: credit_card=${data.credit_card}, mortgage=${data.mortgage}, ` +
      `other=${data.other_loans}, total=${data.total_liabilities_mf}`,
  );

  return ScrapedLiabilitiesSchema.parse(data);
}
