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
          `終了年齢資産 ¥${Math.round(result.endAssetsAtSimEnd).toLocaleString()}（${result.verdict}）`
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
  if (rep.firstDivergence) {
    logger.error(`パリティ乖離: ${rep.firstDivergence}（許容超）。`);
    logger.error(
      "Sheets シミュレーション撤去はまだ不可。engine か設定読込を §4.4 に照合して調整してください。",
    );
    return 6;
  }
  logger.info(
    "パリティ OK。Sheets シミュレーション撤去のゲートを満たしました（DEPLOY_GUIDE 参照）。",
  );
  return 0;
}
