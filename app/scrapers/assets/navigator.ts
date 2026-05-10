import type { Page } from "playwright";
import { logger } from "../../core/logger.js";

export async function navigateToAssetsPage(page: Page, baseUrl: string): Promise<void> {
  logger.info(`Navigating to ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

export async function navigateToLiabilitiesPage(
  page: Page,
  baseUrl: string,
): Promise<void> {
  // baseUrl は MF_ASSETS_URL (=/bs/portfolio) を想定。/bs/liability に置換する。
  const liabilityUrl = baseUrl.replace(/\/portfolio.*$/, "/liability");
  logger.info(`Navigating to ${liabilityUrl}`);
  await page.goto(liabilityUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
