import type {
  AssetSnapshot,
  ManualAssets,
  ScrapedAssetSnapshot,
} from "./schema.js";

export function buildAssetSnapshot(
  scraped: ScrapedAssetSnapshot,
  manual: ManualAssets,
  snapshotDate: string,
): AssetSnapshot {
  const stocks_unlisted = manual.stocks_unlisted;
  const total_assets = scraped.total_assets_mf + stocks_unlisted;
  const total_liabilities = scraped.total_liabilities_mf;
  const net_worth = total_assets - total_liabilities;

  return {
    snapshot_date: snapshotDate,
    cash: scraped.cash,
    stocks_listed: scraped.stocks_listed,
    stocks_unlisted,
    funds: scraped.funds,
    pension: scraped.pension,
    points: scraped.points,
    other_assets: scraped.other_assets,
    total_assets,
    credit_card: scraped.credit_card,
    mortgage: scraped.mortgage,
    other_loans: scraped.other_loans,
    total_liabilities,
    net_worth,
    notes: manual.notes,
  };
}
