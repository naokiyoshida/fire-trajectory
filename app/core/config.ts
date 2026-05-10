import { z } from "zod";
import { ConfigError } from "./errors.js";

// .env で空文字 ("") として渡された値を undefined として扱う。
// dotenv は未設定の変数を undefined にする一方、テンプレを「KEY=」のままにすると ""
// が来るため、optional/email スキーマと噛み合わずエラーになるのを防ぐ。
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
  z.string().optional(),
);
const optionalEmail = z.preprocess(
  (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
  z.string().email().optional(),
);

const envSchema = z.object({
  GOOGLE_SHEET_ID: optionalString,
  GOOGLE_SERVICE_ACCOUNT_JSON: z
    .string()
    .min(1)
    .default("config/google-service-account.json"),
  MF_LOGIN_URL: z.string().url().default("https://moneyforward.com/sign_in"),
  MF_TRANSACTIONS_URL: z.string().url().default("https://moneyforward.com/cf"),
  MF_ASSETS_URL: z.string().url().default("https://moneyforward.com/bs/portfolio"),
  STORAGE_STATE_PATH: z.string().default("data/storage-state.json"),
  SNAPSHOTS_DIR: z.string().default("data/snapshots"),
  SYNC_MONTHS: z.coerce.number().int().positive().default(6),
  FULL_SYNC_START: z
    .string()
    .regex(/^\d{4}\/\d{1,2}$/, "FULL_SYNC_START must be YYYY/MM")
    .default("2021/10"),
  EXCLUDED_INSTITUTIONS: z.string().default(""),
  NOTIFY_EMAIL: optionalEmail,
  GMAIL_USER: optionalEmail,
  GMAIL_APP_PASSWORD: optionalString,
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export interface SheetsConfig {
  sheetId: string;
  serviceAccountJson: string;
}

export function requireSheetsConfig(config: Config): SheetsConfig {
  if (!config.GOOGLE_SHEET_ID) {
    throw new ConfigError(
      "GOOGLE_SHEET_ID is required for Sheets operations. Set it in .env",
    );
  }
  return {
    sheetId: config.GOOGLE_SHEET_ID,
    serviceAccountJson: config.GOOGLE_SERVICE_ACCOUNT_JSON,
  };
}

export function getExcludedInstitutions(config: Config): string[] {
  return config.EXCLUDED_INSTITUTIONS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
