/**
 * パリティ検証: engine の出力と現行 Sheets シミュレーションシートを月次で
 * 突き合わせる。`npm run sim -- --check` から呼ぶ。doctor と同じ
 * 「自己診断1コマンド」方針＝使い捨て比較スクリプトを書かせない。
 *
 * この合否が「整合性 OK → Sheets シミュレーション撤去可」のゲートを兼ねる。
 */
import type { SheetsClient } from "../core/sheets-client.js";
import { quoteSheetName } from "../core/sheets-client.js";
import type { SimMonth } from "./engine.js";

export const SIMULATION_SHEET_NAME = "シミュレーション";

export interface ParityReport {
  comparedCount: number;
  maxEndDiff: number;
  maxNeedDiff: number;
  /** 相対許容を超えた最初の乖離（なければ null） */
  firstDivergence: string | null;
}

/** "2026/05" / "2026/05/01" / Date文字列 → "YYYY/MM" に正規化。 */
function ymKey(v: unknown): string {
  const s = String(v ?? "").trim().replace(/-/g, "/");
  const parts = s.split("/");
  const y = parts[0] ?? "";
  const m = (parts[1] ?? "").padStart(2, "0");
  return y && m ? `${y}/${m}` : s;
}

function num(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 純粋比較。sheetRows は [年月, ...,(H)期末資産=idx7,(I)FIRE必要資産=idx8]。
 * 相対許容 relTol（既定 0.5%）と絶対許容 absTol（既定 1円）の両方を超えたら乖離。
 */
export function compareToSheet(
  engineRows: SimMonth[],
  sheetRows: unknown[][],
  relTol = 0.005,
  absTol = 1,
): ParityReport {
  const byYm = new Map<string, SimMonth>();
  for (const r of engineRows) byYm.set(r.ym, r);

  let comparedCount = 0;
  let maxEndDiff = 0;
  let maxNeedDiff = 0;
  let firstDivergence: string | null = null;

  for (const row of sheetRows) {
    const ym = ymKey(row[0]);
    const er = byYm.get(ym);
    if (!er) continue;
    const sheetEnd = num(row[7]);
    const sheetNeed = num(row[8]);

    if (sheetEnd != null) {
      const diff = Math.abs(sheetEnd - er.endAssets);
      if (diff > maxEndDiff) maxEndDiff = diff;
      if (
        firstDivergence === null &&
        diff > absTol &&
        diff > Math.abs(sheetEnd) * relTol
      ) {
        firstDivergence = `${ym} 期末資産 sheet=${Math.round(
          sheetEnd,
        )} engine=${Math.round(er.endAssets)}`;
      }
    }
    if (sheetNeed != null && er.fireNeed != null) {
      const diff = Math.abs(sheetNeed - er.fireNeed);
      if (diff > maxNeedDiff) maxNeedDiff = diff;
      if (
        firstDivergence === null &&
        diff > absTol &&
        diff > Math.abs(sheetNeed) * relTol
      ) {
        firstDivergence = `${ym} FIRE必要資産 sheet=${Math.round(
          sheetNeed,
        )} engine=${Math.round(er.fireNeed)}`;
      }
    }
    comparedCount++;
  }

  return { comparedCount, maxEndDiff, maxNeedDiff, firstDivergence };
}

/** シミュレーションシートを読み取り（書き込みなし）engine 出力と比較。 */
export async function fetchSheetSimRows(
  client: SheetsClient,
): Promise<unknown[][]> {
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: client.spreadsheetId,
    range: `${quoteSheetName(SIMULATION_SHEET_NAME)}!A2:I`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return (res.data.values ?? []) as unknown[][];
}
