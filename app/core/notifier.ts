import nodemailer, { type Transporter } from "nodemailer";
import { loadConfig, type Config } from "./config.js";
import { logger } from "./logger.js";

export interface Notifier {
  notifyError(subject: string, body: string): Promise<void>;
  notifyInfo(subject: string, body: string): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async notifyError(subject: string, body: string): Promise<void> {
    logger.error(`[Notifier:Console] ${subject}\n${body}`);
  }
  async notifyInfo(subject: string, body: string): Promise<void> {
    logger.info(`[Notifier:Console] ${subject}\n${body}`);
  }
}

export class GmailNotifier implements Notifier {
  private transporter: Transporter;
  private from: string;
  private to: string;

  constructor(gmailUser: string, appPassword: string, to: string) {
    this.from = gmailUser;
    this.to = to;
    this.transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: appPassword },
    });
  }

  async notifyError(subject: string, body: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: this.to,
        subject: `[fire-trajectory ERROR] ${subject}`,
        text: body,
      });
      logger.info(`Sent error notification to ${this.to}`);
    } catch (e: unknown) {
      logger.error("Failed to send error email; falling back to console", {
        error: String(e),
        subject,
      });
      logger.error(`[Notifier:Fallback] ${subject}\n${body}`);
    }
  }

  async notifyInfo(subject: string, body: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: this.to,
        subject: `[fire-trajectory] ${subject}`,
        text: body,
      });
      logger.info(`Sent info notification to ${this.to}`);
    } catch (e: unknown) {
      logger.warn("Failed to send info email; logging only", {
        error: String(e),
        subject,
      });
    }
  }
}

export function makeNotifier(config?: Config): Notifier {
  const cfg = config ?? loadConfig();
  if (cfg.GMAIL_USER && cfg.GMAIL_APP_PASSWORD && cfg.NOTIFY_EMAIL) {
    logger.info(`Using GmailNotifier (from=${cfg.GMAIL_USER}, to=${cfg.NOTIFY_EMAIL})`);
    return new GmailNotifier(cfg.GMAIL_USER, cfg.GMAIL_APP_PASSWORD, cfg.NOTIFY_EMAIL);
  }
  logger.warn(
    "メール通知が未設定のため ConsoleNotifier にフォールバック: 失敗してもメールは飛ばずログのみ。" +
      "無人の月次実行を監視するには .env に GMAIL_USER / GMAIL_APP_PASSWORD / NOTIFY_EMAIL を設定してください。",
  );
  return new ConsoleNotifier();
}
