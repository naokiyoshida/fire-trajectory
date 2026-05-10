import type { Page } from "playwright";

const SIGN_IN_URL_FRAGMENT = "/sign_in";

export const SESSION_INDICATOR_SELECTORS = [
  ".fc-header-title",
  ".transaction-range-display",
  "#cf-detail-table",
  "#transaction_list_body",
] as const;

export function isLoginUrl(url: string): boolean {
  return url.includes(SIGN_IN_URL_FRAGMENT);
}

export async function verifySession(page: Page, verifyUrl: string): Promise<boolean> {
  await page.goto(verifyUrl, { waitUntil: "domcontentloaded" });
  if (isLoginUrl(page.url())) {
    return false;
  }
  for (const selector of SESSION_INDICATOR_SELECTORS) {
    const count = await page.locator(selector).count();
    if (count > 0) return true;
  }
  return false;
}
