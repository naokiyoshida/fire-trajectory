import type { Page } from "playwright";
import { ScrapingError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { loadTransactionsSelectors } from "./selectors.js";

export interface NavigateOptions {
  baseUrl: string;
  year: number;
  month: number;
}

export async function navigateToMonth(page: Page, opts: NavigateOptions): Promise<void> {
  const url = `${opts.baseUrl}?year=${opts.year}&month=${opts.month}`;
  logger.info(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForTransactionsTable(page);
  await waitForCorrectMonth(page, opts.year, opts.month);
}

export async function waitForTransactionsTable(page: Page, timeoutMs = 15000): Promise<void> {
  const { table } = loadTransactionsSelectors();
  const perTry = Math.max(2000, Math.floor(timeoutMs / table.length));
  for (const sel of table) {
    try {
      await page.locator(sel).first().waitFor({ state: "attached", timeout: perTry });
      return;
    } catch {
      // try next selector
    }
  }
  throw new ScrapingError("Transactions table did not appear", "navigator", {
    selectors: table,
    url: page.url(),
  });
}

export async function waitForCorrectMonth(
  page: Page,
  year: number,
  month: number,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastHeader = "";
  while (Date.now() < deadline) {
    const headerText = await getHeaderTitle(page);
    if (headerText) {
      lastHeader = headerText;
      if (matchesMonth(headerText, year, month)) return;
    }
    await page.waitForTimeout(200);
  }
  throw new ScrapingError(
    `Expected ${year}/${month} but header showed: "${lastHeader}"`,
    "navigator",
    { expected: { year, month }, lastHeader },
  );
}

export async function getHeaderTitle(page: Page): Promise<string | null> {
  const { navigation } = loadTransactionsSelectors();
  for (const sel of navigation.header_title) {
    const text = await page
      .locator(sel)
      .first()
      .textContent()
      .catch(() => null);
    if (text && text.trim().length > 0) return text.trim();
  }
  return null;
}

export function matchesMonth(headerText: string, year: number, month: number): boolean {
  const m = headerText.match(/(\d{4})\s*[/.年]\s*(\d{1,2})/);
  if (m && m[1] && m[2]) {
    return parseInt(m[1], 10) === year && parseInt(m[2], 10) === month;
  }
  return headerText.includes(`${month}月`);
}

export async function clickPrevMonth(
  page: Page,
  expectedYear?: number,
  expectedMonth?: number,
): Promise<void> {
  const { navigation } = loadTransactionsSelectors();
  let clicked = false;
  for (const sel of navigation.prev_month) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    throw new ScrapingError("Previous month button not found", "navigator", {
      selectors: navigation.prev_month,
    });
  }

  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  if (expectedYear !== undefined && expectedMonth !== undefined) {
    await waitForCorrectMonth(page, expectedYear, expectedMonth, 15000);
    // ヘッダー切替後にテーブル再レンダリングが間に合うよう少し待機
    await page.waitForTimeout(600);
  } else {
    await page.waitForTimeout(800);
  }
}

export function decrementMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}
