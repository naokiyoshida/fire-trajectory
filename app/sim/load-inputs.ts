/**
 * 「設定」シートを項目名→値で読み取り（読み取り専用）、SimParams を組む。
 *
 * valueRenderOption=UNFORMATTED_VALUE で数値は生値（利率 0.05 等）、
 * dateTimeRenderOption=FORMATTED_STRING で日付は "YYYY/MM/DD" 文字列で得る。
 */
import { logger } from "../core/logger.js";
import type { SheetsClient } from "../core/sheets-client.js";
import { quoteSheetName } from "../core/sheets-client.js";
import { defaultRetireAge, type SimParams } from "./engine.js";

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
  // 年金の物価スライド（engine §4.1b）。0=名目固定〜1=実質固定。日本の年金は
  // マクロ経済スライドで部分的に物価連動するため既定 0.5（名目固定だと35年で実質
  // ほぼ半減し過度に悲観）。設定シートに同名行があれば優先。前提値ゆえコード既定。
  ["年金物価スライド率", "pensionIndexation", "num", 0.5],
  // 分配金課税モデル（engine §4.1a）。これらは銘柄構成で固定なので設定シート
  // （ユーザー編集対象）ではなくここを既定とし、実態を正しく表示する。
  // 2026-05 の保有明細実測:
  //   - 分配を出す VIG/EDV/SBI日本高配当/SBI・V米国高配当 は全額 NISA →
  //     NISA比率=1.0（国内分配課税ドラッグ 0）。
  //   - 分配金利回り=0.011（分配 ≒324千円/年 ÷ 総資産29.25M、総資産比）。
  //   - 外国源泉割合=0.8（分配の約8割が米株由来：VIG・SBI・V米国高配当が主、
  //     国内源泉は SBI日本高配当のみ）。NISA でも外国源泉税≒10%は回収不能で、
  //     0.011×0.8×0.10 ≒ 0.088%/年 の恒久ドラッグ。NISA100%でも残る実コスト。
  // 設定シートに同名行があればそちらが優先（将来 特定口座に積む等で上書き可能）。
  // リバランスで NISA 配分・米株比率が変わったら再算定すること。
  ["分配金利回り", "dividendYield", "num", 0.011],
  ["NISA比率", "nisaRatio", "num", 1.0],
  ["分配の外国源泉割合", "foreignDivShare", "num", 0.8],
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
  // 年金額は「65歳で受け取る標準額（ねんきん定期便の65歳見込額）」で入力する。
  // engine が開始年齢に応じ pensionFactor で繰上げ/繰下げ換算する（§4.1b）。
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
  // NFKC で全角数字（０-９）・全角記号（￥，）等を半角化してから不要記号を除去。
  // これを怠ると全角金額が Number("")→0 に黙って化け、資産/月収が 0 になる。
  // 指数表記 (1.5e3 等) も Sheets API が UNFORMATTED_VALUE で大きな数を
  // 科学表記で返してくる場合があるため e/E を残す（除去すると 1.5e3→1.53）。
  const s = String(v ?? "")
    .normalize("NFKC")
    .replace(/[−ー]/g, "-"); // 全角マイナス/長音→ASCII ハイフン
  const n = Number(s.replace(/[^\deE.+\-]/g, ""));
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

/**
 * asOf（実行月の月初）を "YYYY-MM-01" で返す。
 * ローカル時刻の年月を意図的に使う（本ツールは JST 単一マシン運用。
 * UTC 化すると月末深夜に翌月へ先送りされ実行月がずれるため不可）。
 */
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
  // UI 退職年齢スライダーの既定。selfBirth/selfRetireDate は必須なので
  // ここでは必ず存在する。engine の年齢パスと逆写像なので通常ケースは
  // selfRetireDate と厳密一致＝既存挙動を変えない（後方互換）。
  out.selfRetireAge = defaultRetireAge(
    out.selfBirth as string,
    out.selfRetireDate as string,
  );
  // 配偶者の退職年齢スライダー既定も日付から導出（本人と対称・UI 用・後方互換）。
  out.spouseRetireAge = defaultRetireAge(
    out.spouseBirth as string,
    out.spouseRetireDate as string,
  );
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
