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
      source: r.source,
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

export function parseDateMatch(raw: string): { month: number; day: number } | null {
  const m = raw.match(/(\d{1,2})\s*[/／]\s*(\d{1,2})/);
  if (!m || !m[1] || !m[2]) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (Number.isNaN(month) || Number.isNaN(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}
