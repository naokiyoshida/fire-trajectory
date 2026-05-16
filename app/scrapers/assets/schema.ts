import { z } from "zod";

// /bs/portfolio から抽出する生データ
export const ScrapedAssetsSchema = z.object({
  cash: z.number().int(),
  stocks_listed: z.number().int(),
  funds: z.number().int(),
  pension: z.number().int(),
  points: z.number().int(),
  other_assets: z.number().int(),
  total_assets_mf: z.number().int(),
});

// /bs/liability から抽出する生データ
export const ScrapedLiabilitiesSchema = z.object({
  credit_card: z.number().int(),
  mortgage: z.number().int(),
  other_loans: z.number().int(),
  total_liabilities_mf: z.number().int(),
});

// scraped 全体（refine で内訳と合計の整合性チェック）
export const ScrapedAssetSnapshotSchema = ScrapedAssetsSchema.merge(
  ScrapedLiabilitiesSchema,
)
  .refine(
    (d) => {
      const sum =
        d.cash + d.stocks_listed + d.funds + d.pension + d.points + d.other_assets;
      return Math.abs(sum - d.total_assets_mf) <= 1;
    },
    { message: "Sum of asset categories does not match total_assets_mf" },
  )
  .refine(
    (d) => {
      const sum = d.credit_card + d.mortgage + d.other_loans;
      return Math.abs(sum - d.total_liabilities_mf) <= 1;
    },
    { message: "Sum of liability categories does not match total_liabilities_mf" },
  );

export type ScrapedAssets = z.infer<typeof ScrapedAssetsSchema>;
export type ScrapedLiabilities = z.infer<typeof ScrapedLiabilitiesSchema>;
export type ScrapedAssetSnapshot = z.infer<typeof ScrapedAssetSnapshotSchema>;

// 手動入力（Manual_Assets シート）由来の追加項目
export const ManualAssetsSchema = z.object({
  stocks_unlisted: z.number().int().default(0),
  notes: z.string().default(""),
});
export type ManualAssets = z.infer<typeof ManualAssetsSchema>;

// Sheets に書き込む最終形（scraped + manual + 計算値）
export const AssetSnapshotSchema = z.object({
  snapshot_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  // 資産
  cash: z.number().int(),
  stocks_listed: z.number().int(),
  stocks_unlisted: z.number().int(),
  funds: z.number().int(),
  pension: z.number().int(),
  points: z.number().int(),
  other_assets: z.number().int(),
  total_assets: z.number().int(),
  // 負債
  credit_card: z.number().int(),
  mortgage: z.number().int(),
  other_loans: z.number().int(),
  total_liabilities: z.number().int(),
  // 計算値
  net_worth: z.number().int(),
  notes: z.string(),
}).refine((d) => d.total_assets > 0, {
  message: "total_assets must be > 0（全0スクレイプ＝取得失敗の疑い）",
  path: ["total_assets"],
});
export type AssetSnapshot = z.infer<typeof AssetSnapshotSchema>;
