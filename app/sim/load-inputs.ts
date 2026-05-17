/**
 * 「設定」シートを項目名→値で読み取り（読み取り専用）、SimParams を組む。
 *
 * valueRenderOption=UNFORMATTED_VALUE で数値は生値（利率 0.05 等）、
 * dateTimeRenderOption=FORMATTED_STRING で日付は "YYYY/MM/DD" 文字列で得る。
 */
import { logger } from "../core/logger.js";
import type { SheetsClient } from "../core/sheets-client.js";
import { quoteSheetName } from "../core/sheets-client.js";
import type { SimParams } from "./engine.js";

export const SETTINGS_SHEET_NAME = "設定";

type Kind = "num" | "date";

/**
 * 設定シート A列の項目名 → SimParams フィールド／種別。
 * 4要素目を与えると「任意項目」: シート未掲載でもその既定値で続行し
 * （sim が止まらない＝設計変更容易性）、どの項目が既定だったかを警告で出す。
 * 項目を増やすときはここに1行足すだけ（engine 側の型も拡張）。
 */
const MAP: ReadonlyArray<
  readonly [string, keyof SimParams, Kind, (number | string)?]
> = [
  ["現在の資産", "currentAssets", "num"],
  ["基本生活費_月額", "baseLivingMonthly", "num"],
  ["ローン月額", "loanMonthly", "num"],
  ["ローン完済予定日", "loanEndDate", "date"],
  ["息子支援月額", "childSupportMonthly", "num"],
  ["息子支援終了日", "childSupportEndDate", "date"],
  // 監査で追加した新項目。既存の設定シートには未掲載のことがあるため
  // 任意（既定 0）。0=保守側ではなく過小評価になるので警告で気付かせる。
  ["退職後社会保険料_月額", "postRetireInsuranceMonthly", "num", 0],
  ["運用利回り_名目", "nominalYield", "num"],
  ["インフレ率", "inflation", "num"],
  ["FIRE射程_盤石閾値", "fireSolidThreshold", "num"],
  ["FIRE射程_余裕閾値", "fireComfortThreshold", "num"],
  ["FIRE必要資産_目標年齢", "fireTargetAge", "num"],
  ["FIRE必要資産_目標残額", "fireTargetRemain", "num"],
  ["シミュレーション終了年齢", "simEndAge", "num"],
  ["本人誕生日", "selfBirth", "date"],
  ["リタイア予定日", "selfRetireDate", "date"],
  ["本人月収_家計入金", "selfMonthlyIncome", "num"],
  ["本人ボーナス_年額_家計入金", "selfBonusAnnual", "num"],
  ["本人退職時一時金", "selfRetireLump", "num"],
  ["本人年金_年額", "selfPensionAnnual", "num"],
  ["本人年金開始年齢", "selfPensionStartAge", "num"],
  ["配偶者誕生日", "spouseBirth", "date"],
  ["配偶者退職予定日", "spouseRetireDate", "date"],
  ["配偶者月収_家計入金", "spouseMonthlyIncome", "num"],
  ["配偶者ボーナス_年額_家計入金", "spouseBonusAnnual", "num"],
  ["配偶者退職時一時金", "spouseRetireLump", "num"],
  ["配偶者年金_年額", "spousePensionAnnual", "num"],
  ["配偶者年金開始年齢", "spousePensionStartAge", "num"],
];

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** "1977/03/09" / "1977-3-9" / Date → "YYYY-MM-DD" */
function toIsoDate(v: unknown): string {
  const s = String(v ?? "").trim();
  const parts = s.replace(/-/g, "/").split("/");
  const y = Number(parts[0]);
  const m = Number(parts[1] ?? "1");
  const d = Number(parts[2] ?? "1");
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`設定の日付が解釈できません: "${s}"`);
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** asOf（実行月の月初）を "YYYY-MM-01" で返す。 */
export function todayAsOf(now = new Date()): string {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/**
 * 設定シートの [A=項目名, B=値] 配列から SimParams を構築（純粋・テスト可能）。
 */
export function buildSimParams(
  rows: unknown[][],
  asOf = todayAsOf(),
  onDefaulted?: (notes: string[]) => void,
): SimParams {
  const byName = new Map<string, unknown>();
  for (const r of rows) {
    const name = String(r[0] ?? "").trim();
    if (name) byName.set(name, r[1]);
  }
  const out: Record<string, unknown> = { asOf };
  const missingRequired: string[] = [];
  const defaulted: string[] = [];
  for (const [name, field, kind, fallback] of MAP) {
    if (!byName.has(name)) {
      if (fallback === undefined) {
        missingRequired.push(name);
      } else {
        out[field] = fallback;
        defaulted.push(`${name}=${String(fallback)}`);
      }
      continue;
    }
    const raw = byName.get(name);
    out[field] = kind === "date" ? toIsoDate(raw) : toNum(raw);
  }
  if (missingRequired.length > 0) {
    throw new Error(
      `設定シートに必須項目がありません: ${missingRequired.join(", ")}`,
    );
  }
  if (defaulted.length > 0 && onDefaulted) onDefaulted(defaulted);
  return out as unknown as SimParams;
}

/** 設定シートを読み取り（書き込みなし）、SimParams を返す。 */
export async function loadSimParams(
  client: SheetsClient,
  asOf = todayAsOf(),
): Promise<SimParams> {
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: client.spreadsheetId,
    range: `${quoteSheetName(SETTINGS_SHEET_NAME)}!A2:B`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = (res.data.values ?? []) as unknown[][];
  return buildSimParams(rows, asOf, (notes) =>
    logger.warn(
      `設定シート未掲載の任意項目を既定値で補完: ${notes.join(", ")}。` +
        `正確を期すなら設定シートに行を追加してください（DEPLOY_GUIDE 参照）。`,
    ),
  );
}
