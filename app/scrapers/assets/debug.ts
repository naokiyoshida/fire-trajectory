import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { launchBrowser } from "../../core/browser.js";
import { loadConfig } from "../../core/config.js";
import { logger } from "../../core/logger.js";

/**
 * 任意のURLにアクセスしてHTMLをdata/snapshots/に保存する。
 * セレクタ調査やテストフィクスチャ作成のためのデバッグコマンド。
 */
export async function saveSnapshot(url: string, label: string): Promise<string> {
  const config = loadConfig();
  const headless = process.env.HEADLESS !== "false";
  const browser = await launchBrowser({
    storageStatePath: config.STORAGE_STATE_PATH,
    headless,
  });

  try {
    logger.info(`Navigating to ${url}`);
    await browser.page.goto(url, { waitUntil: "domcontentloaded" });
    await browser.page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => {});
    // SPA レンダリング待ち
    await browser.page.waitForTimeout(2000);

    const finalUrl = browser.page.url();
    const title = await browser.page.title();
    logger.info(`Final URL: ${finalUrl}`);
    logger.info(`Title: ${title}`);

    const html = await browser.page.content();

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_");
    const outPath = join(config.SNAPSHOTS_DIR, `${safeLabel}-${ts}.html`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html, "utf-8");
    logger.info(`Saved ${html.length} bytes to ${outPath}`);

    return outPath;
  } finally {
    await browser.close();
  }
}

/**
 * 資産ページのスナップショット（後方互換用）。
 */
export async function saveAssetsPageSnapshot(): Promise<string> {
  const config = loadConfig();
  return saveSnapshot(config.MF_ASSETS_URL, "assets");
}
