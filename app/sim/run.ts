/**
 * `npm run sim` のオーケストレーション。
 * 設定シートを読み取り専用で取得 → engine 実行 → dist/fire.html 生成。
 *
 * シミュレーション計算の唯一の正は engine.ts。Sheets 側のシミュレーション
 * 機能（setupSimulation / FIRE射程 / パリティ比較）は撤去済み（§4.5）。
 */
import { loadConfig, requireSheetsConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import { createSheetsClient } from "../core/sheets-client.js";
import { simulate } from "./engine.js";
import { loadSimParams } from "./load-inputs.js";
import { renderHtml } from "./render-html.js";

export async function runSim(): Promise<void> {
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
}
