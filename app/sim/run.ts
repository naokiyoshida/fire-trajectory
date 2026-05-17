/**
 * `npm run sim` / `npm run sim -- --check` のオーケストレーション。
 * 設定シートを読み取り専用で取得 → engine 実行 → dist/fire.html 生成。
 * --check 時は現行シミュレーションシートとパリティ比較し exit code を返す。
 */
import { loadConfig, requireSheetsConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import { createSheetsClient } from "../core/sheets-client.js";
import { simulate } from "./engine.js";
import { loadSimParams } from "./load-inputs.js";
import { compareToSheet, fetchSheetSimRows } from "./parity.js";
import { renderHtml } from "./render-html.js";

export interface RunSimOptions {
  check?: boolean;
}

/** 戻り値は CLI 終了コード（0=正常、6=パリティ乖離）。 */
export async function runSim(options: RunSimOptions = {}): Promise<number> {
  const cfg = requireSheetsConfig(loadConfig());
  const client = await createSheetsClient(cfg.sheetId, cfg.serviceAccountJson);

  const params = await loadSimParams(client);
  const result = simulate(params);
  const out = renderHtml(params);

  logger.info(`シミュレーション HTML を生成: ${out}`);
  logger.info(
    result.fireDate
      ? `FIRE可能時期: ${result.fireDate}（本人 ${result.ageAtFire}歳） / ` +
          `その時退職した場合の終了年齢資産 ¥${Math.round(
            result.fireEndAssets ?? 0,
          ).toLocaleString()}（${result.verdict}） / ` +
          `就労継続だと ¥${Math.round(result.endAssetsAtSimEnd).toLocaleString()}`
      : `現設定では目標年齢までに FIRE 必要資産へ未到達` +
          (result.depletionMonth ? `（資産枯渇 ${result.depletionMonth}）` : ""),
  );
  logger.info(`ブラウザで開く: file://${out.replace(/\\/g, "/")}`);

  if (!options.check) return 0;

  const sheetRows = await fetchSheetSimRows(client);
  const rep = compareToSheet(result.monthly, sheetRows);
  logger.info(
    `パリティ: ${rep.comparedCount} ヶ月比較 / 期末資産 最大差 ¥${Math.round(
      rep.maxEndDiff,
    ).toLocaleString()} / FIRE必要資産 最大差 ¥${Math.round(
      rep.maxNeedDiff,
    ).toLocaleString()}`,
  );
  // 自己整合モデル（§4.3）採用後、engine はレガシー GAS シミュとは設計上
  // 意図的に乖離する（engine が唯一の正・GAS シミュは撤去対象）。よって
  // --check は撤去ゲートではなく**参考情報**。乖離があっても exit 0。
  if (rep.firstDivergence) {
    logger.info(
      `（参考）レガシー GAS シミュとの差: ${rep.firstDivergence}。` +
        "自己整合モデル移行による設計どおりの乖離（engine が正）。",
    );
  } else {
    logger.info("（参考）レガシー GAS シミュと一致。");
  }
  return 0;
}
