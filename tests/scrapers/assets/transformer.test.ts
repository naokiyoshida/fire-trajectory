import { describe, expect, it } from "vitest";
import { buildAssetSnapshot } from "../../../app/scrapers/assets/transformer.js";
import type { ScrapedAssetSnapshot } from "../../../app/scrapers/assets/schema.js";

const scrapedSample: ScrapedAssetSnapshot = {
  cash: 850_237,
  stocks_listed: 8_117_474,
  funds: 8_249_706,
  pension: 11_144_819,
  points: 6_743,
  other_assets: 0,
  total_assets_mf: 28_368_979,
  credit_card: 685_730,
  mortgage: 9_659_782,
  other_loans: 797_008,
  total_liabilities_mf: 11_142_520,
};

describe("assets/transformer/buildAssetSnapshot", () => {
  it("merges scraped + manual and computes net_worth", () => {
    const snap = buildAssetSnapshot(
      scrapedSample,
      { stocks_unlisted: 1_550_000, notes: "インテグレ含む" },
      "2026-05-31",
    );
    expect(snap.snapshot_date).toBe("2026-05-31");
    expect(snap.stocks_unlisted).toBe(1_550_000);
    expect(snap.total_assets).toBe(28_368_979 + 1_550_000);
    expect(snap.total_liabilities).toBe(11_142_520);
    expect(snap.net_worth).toBe(28_368_979 + 1_550_000 - 11_142_520);
    expect(snap.notes).toBe("インテグレ含む");
  });

  it("works without manual assets", () => {
    const snap = buildAssetSnapshot(
      scrapedSample,
      { stocks_unlisted: 0, notes: "" },
      "2026-05-31",
    );
    expect(snap.total_assets).toBe(28_368_979);
    expect(snap.net_worth).toBe(28_368_979 - 11_142_520);
  });
});
