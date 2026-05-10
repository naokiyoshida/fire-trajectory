#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { logger } from "./core/logger.js";

loadDotenv();

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "sync": {
      const dryRun = process.argv.includes("--dry-run");
      const fullSync = process.argv.includes("--full");
      const { syncTransactions } = await import("./pipeline/sync-transactions.js");
      const { syncAssets } = await import("./pipeline/sync-assets.js");
      const tx = await syncTransactions({ dryRun, fullSync });
      logger.info(
        `syncTransactions: scraped=${tx.scraped}, unique=${tx.unique}, appended=${tx.appended}, months=${tx.monthsScanned}, fullMode=${tx.fullMode}`,
      );
      const assets = await syncAssets({ dryRun });
      logger.info(
        `syncAssets: scraped=${assets.scraped}, appended=${assets.appended}, skipped=${assets.skipped}${assets.reason ? ` (${assets.reason})` : ""}`,
      );
      break;
    }
    case "sync-transactions": {
      const dryRun = process.argv.includes("--dry-run");
      const fullSync = process.argv.includes("--full");
      const { syncTransactions } = await import("./pipeline/sync-transactions.js");
      const result = await syncTransactions({ dryRun, fullSync });
      logger.info(
        `syncTransactions done: scraped=${result.scraped}, unique=${result.unique}, appended=${result.appended}, months=${result.monthsScanned}, fullMode=${result.fullMode}`,
      );
      break;
    }
    case "sync-assets": {
      const dryRun = process.argv.includes("--dry-run");
      const { syncAssets } = await import("./pipeline/sync-assets.js");
      const result = await syncAssets({ dryRun });
      logger.info(
        `syncAssets done: scraped=${result.scraped}, appended=${result.appended}, skipped=${result.skipped}, dryRun=${result.dryRun}${result.reason ? ` (${result.reason})` : ""}`,
      );
      break;
    }
    case "login": {
      const { runLogin } = await import("./auth/login.js");
      await runLogin();
      break;
    }
    case "check-session": {
      const { checkSession } = await import("./auth/login.js");
      const ok = await checkSession();
      logger.info(`Session valid: ${ok}`);
      if (!ok) process.exit(2);
      break;
    }
    case "health-check": {
      logger.info("health-check: not implemented yet");
      break;
    }
    case "snapshot-assets": {
      const { saveAssetsPageSnapshot } = await import("./scrapers/assets/debug.js");
      const path = await saveAssetsPageSnapshot();
      logger.info(`Snapshot saved: ${path}`);
      break;
    }
    case "snapshot": {
      const url = process.argv[3];
      const label = process.argv[4] ?? "page";
      if (!url) {
        console.error("Usage: tsx app/cli.ts snapshot <url> [label]");
        process.exit(1);
      }
      const { saveSnapshot } = await import("./scrapers/assets/debug.js");
      const path = await saveSnapshot(url, label);
      logger.info(`Snapshot saved: ${path}`);
      break;
    }
    default: {
      console.error("Usage: tsx app/cli.ts <sync|login|health-check>");
      process.exit(1);
    }
  }
}

main().catch(async (err: unknown) => {
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error("Fatal error", { error: String(err), stack });

  // Best-effort email notification
  try {
    const { makeNotifier } = await import("./core/notifier.js");
    const notifier = makeNotifier();
    const subject = `${command ?? "cli"} failed`;
    const body = `Command: ${command ?? "(none)"}\nArgs: ${process.argv.slice(2).join(" ")}\n\nError: ${String(err)}\n\nStack:\n${stack ?? "(no stack)"}`;
    await notifier.notifyError(subject, body);
  } catch (notifyErr: unknown) {
    logger.error("Notifier itself failed", { error: String(notifyErr) });
  }
  process.exit(1);
});
