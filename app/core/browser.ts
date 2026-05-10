import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";

export interface BrowserOptions {
  storageStatePath: string;
  headless: boolean;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  saveStorageState(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function launchBrowser(opts: BrowserOptions): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: opts.headless });
  const contextOpts: BrowserContextOptions = {
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  };
  if (existsSync(opts.storageStatePath)) {
    contextOpts.storageState = opts.storageStatePath;
  }
  const context = await browser.newContext(contextOpts);

  // navigator.webdriver を消すなど、軽い自動化検出回避
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async saveStorageState() {
      await mkdir(dirname(opts.storageStatePath), { recursive: true });
      await context.storageState({ path: opts.storageStatePath });
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
