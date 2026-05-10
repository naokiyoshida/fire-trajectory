import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { launchBrowser } from "../core/browser.js";
import { loadConfig } from "../core/config.js";
import { AuthError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { verifySession } from "./session.js";

export async function runLogin(): Promise<void> {
  const config = loadConfig();

  logger.info("Launching browser (headed) for initial login");
  const session = await launchBrowser({
    storageStatePath: config.STORAGE_STATE_PATH,
    headless: false,
  });

  try {
    logger.info(`Navigating to ${config.MF_LOGIN_URL}`);
    await session.page.goto(config.MF_LOGIN_URL, { waitUntil: "domcontentloaded" });

    const rl = createInterface({ input: stdin, output: stdout });
    await rl.question(
      "\n>>> ブラウザでログイン + 2FA を完了し、ダッシュボードが表示されたらこの画面で Enter を押してください: ",
    );
    rl.close();

    logger.info("Verifying session by visiting the transactions page");
    const ok = await verifySession(session.page, config.MF_TRANSACTIONS_URL);

    if (!ok) {
      throw new AuthError(
        "セッション検証に失敗しました。ログイン後のページを認識できませんでした。",
      );
    }

    logger.info(`Saving storage state to ${config.STORAGE_STATE_PATH}`);
    await session.saveStorageState();

    logger.info("ログイン完了。次回からはヘッドレスで動作します。");
  } finally {
    await session.close();
  }
}

export async function checkSession(): Promise<boolean> {
  const config = loadConfig();
  const headless = process.env.HEADLESS !== "false";
  logger.info(`Checking session (headless=${headless})`);
  const session = await launchBrowser({
    storageStatePath: config.STORAGE_STATE_PATH,
    headless,
  });

  try {
    const ok = await verifySession(session.page, config.MF_TRANSACTIONS_URL);
    logger.info(`Final URL after navigation: ${session.page.url()}`);
    return ok;
  } finally {
    await session.close();
  }
}
