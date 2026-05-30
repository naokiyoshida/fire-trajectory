import type { Page } from "playwright";
import { logger } from "../../core/logger.js";
import { RawTransactionSchema, type RawTransaction } from "./schema.js";
import { loadTransactionsSelectors, type TransactionsSelectors } from "./selectors.js";

interface RawRow {
  date: string;
  content: string;
  amount: string;
  source: string;
  categoryLarge: string;
  categoryMiddle: string;
  flags: { transfer: boolean; excluded: boolean };
}

export async function extractTransactions(
  page: Page,
  year: number,
  month: number,
): Promise<RawTransaction[]> {
  const selectors = loadTransactionsSelectors();
  const rawRows = await scrapeRowsFromPage(page, selectors);
  const filtered = filterAndShape(rawRows, year, month);
  logger.info(`Extracted ${filtered.length} transactions for ${year}/${month}`);
  return filtered;
}

async function scrapeRowsFromPage(
  page: Page,
  selectors: TransactionsSelectors,
): Promise<RawRow[]> {
  // NOTE: page.evaluate のコールバック内では関数宣言を使わないこと。
  // esbuild (tsx) が __name でラップして ReferenceError を起こすため、
  // すべての処理をインラインの for ループで書く。
  return page.evaluate((sel) => {
    const out: RawRow[] = [];

    let tableEl: Element | null = null;
    for (const s of sel.table) {
      tableEl = document.querySelector(s);
      if (tableEl) break;
    }
    if (!tableEl) return out;

    const rowSelector = sel.row[0] ?? "tr";
    const rows = Array.from(tableEl.querySelectorAll(rowSelector)) as Element[];

    for (const row of rows) {
      const cells = row.querySelectorAll("td");

      let dateText = "";
      for (const s of sel.cell.date) {
        const el = row.querySelector(s);
        if (el) {
          dateText = (el.textContent ?? "").trim();
          break;
        }
      }
      if (!dateText && cells.length > 0) {
        dateText = (cells[0]?.textContent ?? "").trim();
      }

      let contentText = "";
      for (const s of sel.cell.content) {
        const el = row.querySelector(s);
        if (el) {
          contentText = (el.textContent ?? "").trim();
          break;
        }
      }
      if (!contentText && cells.length > 1) {
        contentText = (cells[1]?.textContent ?? "").trim();
      }

      let amountText = "";
      for (const s of sel.cell.amount) {
        const el = row.querySelector(s);
        if (el) {
          amountText = (el.textContent ?? "").trim();
          break;
        }
      }
      if (!amountText && cells.length > 2) {
        amountText = (cells[2]?.textContent ?? "").trim();
      }

      // TODO(次回ログイン取得時): 手入力取引で金融機関欄が <select> のとき
      // textContent が全 option を連結する（取引履歴 4446/4447 の "なし/インテグレ
      // /なし"）。実支払い方法は MF に登録されているはずなので selectedIndex の
      // option を読めば本当の値が取れる可能性が高い。実 DOM を確認し、select なら
      // sel.options[sel.selectedIndex] を採用する分岐を入れる（"なし" は暫定仮値）。
      let sourceText = "";
      for (const s of sel.cell.source) {
        const el = row.querySelector(s);
        if (el) {
          sourceText = (el.textContent ?? "").trim();
          break;
        }
      }
      if (!sourceText && cells.length > 4) {
        sourceText = (cells[4]?.textContent ?? "").trim();
      }

      let categoryLargeText = "";
      for (const s of sel.cell.category_large) {
        const el = row.querySelector(s);
        if (el) {
          categoryLargeText = (el.textContent ?? "").trim();
          break;
        }
      }
      if (!categoryLargeText && cells.length > 5) {
        categoryLargeText = (cells[5]?.textContent ?? "").trim();
      }

      let categoryMiddleText = "";
      for (const s of sel.cell.category_middle) {
        const el = row.querySelector(s);
        if (el) {
          categoryMiddleText = (el.textContent ?? "").trim();
          break;
        }
      }
      if (!categoryMiddleText && cells.length > 6) {
        categoryMiddleText = (cells[6]?.textContent ?? "").trim();
      }

      let transferFlag = false;
      for (const c of sel.flags.is_transfer.classes) {
        if (row.classList.contains(c)) {
          transferFlag = true;
          break;
        }
      }
      if (!transferFlag && amountText.includes(sel.flags.is_transfer.text_marker)) {
        transferFlag = true;
      }

      let excludedFlag = false;
      for (const c of sel.flags.is_excluded.classes) {
        if (row.classList.contains(c)) {
          excludedFlag = true;
          break;
        }
      }
      if (!excludedFlag) {
        for (const s of sel.flags.is_excluded.children) {
          if (row.querySelector(s)) {
            excludedFlag = true;
            break;
          }
        }
      }

      out.push({
        date: dateText,
        content: contentText,
        amount: amountText,
        source: sourceText,
        categoryLarge: categoryLargeText,
        categoryMiddle: categoryMiddleText,
        flags: { transfer: transferFlag, excluded: excludedFlag },
      });
    }

    return out;
  }, selectors);
}

function filterAndShape(rows: RawRow[], year: number, month: number): RawTransaction[] {
  const result: RawTransaction[] = [];
  for (const r of rows) {
    if (r.flags.transfer || r.flags.excluded) continue;
    if (!r.date || !r.content || !r.amount) continue;

    const parsed = parseDateMatch(r.date);
    if (!parsed) continue;
    if (parsed.month !== month) continue;

    const date = `${year}/${String(parsed.month).padStart(2, "0")}/${String(parsed.day).padStart(2, "0")}`;
    const category = [r.categoryLarge, r.categoryMiddle].filter(Boolean).join("/");

    const candidate: RawTransaction = {
      date,
      content: r.content,
      amount: cleanAmount(r.amount),
      source: cleanSource(r.source),
      category,
    };

    const validation = RawTransactionSchema.safeParse(candidate);
    if (validation.success) {
      result.push(validation.data);
    } else {
      logger.warn("Skipping invalid transaction row", {
        candidate,
        issues: validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
  }
  return result;
}

export function cleanAmount(raw: string): string {
  return raw.replace(/[,円\s]/g, "").replace(/\(振替\)/g, "");
}

/**
 * 保有金融機関セルの正規化。MF の手入力（口座未連携）取引では金融機関欄が
 * select となり、textContent に "なし\n\n\nインテグレ (…)\nなし" のように全
 * option ラベルが改行ごと連結されて入ることがある（実例: 取引履歴 4446/4447）。
 * 内部の連続空白・改行を単一スペースに畳み前後を trim して、生の改行が
 * シートへ流入するのを防ぐ。通常の金融機関名は内部に連続空白を持たないため
 * 値（＝自然キー/ID）は不変で、既存行との互換が保たれる。
 */
export function cleanSource(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function parseDateMatch(raw: string): { month: number; day: number } | null {
  const m = raw.match(/(\d{1,2})\s*[/／]\s*(\d{1,2})/);
  if (!m || !m[1] || !m[2]) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (Number.isNaN(month) || Number.isNaN(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}
