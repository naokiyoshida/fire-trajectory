/**
 * MF の DOM 調査用（読み取り専用・一時保守）。宿題2件を実機確認する:
 *   portfolio … /bs/portfolio の保有明細テーブルと NISA 表記を構造化ダンプ
 *   cf-select … /cf の手入力取引(4446/4447相当)の金融機関 select を実値ダンプ
 *
 * 使い方:
 *   npx tsx scripts/inspect-mf.ts portfolio
 *   npx tsx scripts/inspect-mf.ts cf-select
 */
import { launchBrowser } from "../app/core/browser.js";
import { loadConfig } from "../app/core/config.js";
import {
  clickPrevMonth,
  decrementMonth,
  navigateToMonth,
} from "../app/scrapers/transactions/navigator.js";

async function withPage<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const headless = process.env.HEADLESS !== "false";
  const browser = await launchBrowser({
    storageStatePath: config.STORAGE_STATE_PATH,
    headless,
  });
  try {
    return await fn(browser.page);
  } finally {
    await browser.close();
  }
}

async function portfolio(): Promise<void> {
  const config = loadConfig();
  await withPage(async (page) => {
    await page.goto(config.MF_ASSETS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const data = await page.evaluate(() => {
      const tables: Array<{
        id: string;
        cls: string;
        heading: string;
        headers: string[];
        rowCount: number;
        rows: string[][];
      }> = [];
      const all = Array.from(document.querySelectorAll("table"));
      for (const t of all) {
        // 直近の見出し（祖先をたどり前方の見出し系要素を拾う）
        let heading = "";
        let node: Element | null = t;
        while (node && !heading) {
          let sib: Element | null = node.previousElementSibling;
          while (sib) {
            const tag = sib.tagName.toLowerCase();
            if (/^h[1-4]$/.test(tag) || /heading|title/i.test(sib.className)) {
              heading = (sib.textContent || "").trim().replace(/\s+/g, " ");
              break;
            }
            sib = sib.previousElementSibling;
          }
          node = node.parentElement;
        }
        const headers = Array.from(t.querySelectorAll("thead th, thead td")).map(
          (e) => (e.textContent || "").trim().replace(/\s+/g, " "),
        );
        if (/table-condensed/.test(t.className)) continue; // カレンダー等は除外
        const bodyRows = Array.from(t.querySelectorAll("tbody tr"));
        const rows: string[][] = [];
        for (const r of bodyRows.slice(0, 40)) {
          rows.push(
            Array.from(r.querySelectorAll("th, td")).map((e) =>
              (e.textContent || "").trim().replace(/\s+/g, " "),
            ),
          );
        }
        tables.push({
          id: t.id || "",
          cls: t.className || "",
          heading: heading.slice(0, 40),
          headers,
          rowCount: bodyRows.length,
          rows,
        });
      }
      // NISA 表記の有無（口座種別の手がかり）
      const nisaHits: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const tx = (n.nodeValue || "").trim();
        if (/NISA|つみたて|特定口座|一般口座/.test(tx)) {
          nisaHits.push(tx.replace(/\s+/g, " ").slice(0, 60));
        }
      }
      return { url: location.href, tables, nisaHits: nisaHits.slice(0, 30) };
    });

    console.log("URL:", data.url);
    console.log("=== NISA/口座種別の文言ヒット ===");
    for (const h of [...new Set(data.nisaHits)]) console.log("  •", h);
    console.log("\n=== テーブル一覧 ===");
    for (const t of data.tables) {
      console.log(
        `\n#${t.id || "(no id)"} .${t.cls} | 見出し: ${t.heading} | ${t.rowCount}行`,
      );
      if (t.headers.length) console.log("  列:", t.headers.join(" | "));
      t.rows.forEach((r, i) => console.log(`  [${i}]`, r.join(" | ")));
    }
  });
}

async function cfSelect(): Promise<void> {
  const config = loadConfig();
  await withPage(async (page) => {
    // MF は URL の year/month で過去月へ飛べない（当月固定）。当月から prev
    // ボタンで 2022/02 まで遡る（sync と同じ方式）。
    const now = new Date();
    let y = now.getFullYear();
    let mo = now.getMonth() + 1;
    await navigateToMonth(page, { baseUrl: config.MF_TRANSACTIONS_URL, year: y, month: mo });
    const TY = 2022;
    const TM = 2;
    let guard = 0;
    while ((y !== TY || mo !== TM) && guard++ < 80) {
      const next = decrementMonth(y, mo);
      await clickPrevMonth(page, next.year, next.month);
      y = next.year;
      mo = next.month;
    }
    await page.waitForTimeout(800);

    const data = await page.evaluate(() => {
      const targets = ["魚魚鈴", "炭焼珈琲ヨシダ"];
      const out: Array<{
        content: string;
        fiOuter: string;
        isSelect: boolean;
        selectedText: string;
        options: Array<{ text: string; selected: boolean }>;
      }> = [];
      const rows = Array.from(document.querySelectorAll("tr"));
      // 診断: 金融機関セルの総数/select数、月見出し、先頭数件の内容と型
      const fiAll = Array.from(document.querySelectorAll(".qt-financial_institution"));
      const diag = {
        trCount: rows.length,
        fiCount: fiAll.length,
        fiSelectCount: fiAll.filter(
          (e) => e.tagName === "SELECT" || !!e.querySelector("select"),
        ).length,
        rangeText: (
          document.querySelector(".fc-header-title, .transaction-range-display")
            ?.textContent || ""
        )
          .trim()
          .replace(/\s+/g, " "),
        sample: rows
          .map((r) => {
            const c = (r.querySelector(".content")?.textContent || "")
              .trim()
              .replace(/\s+/g, " ");
            const fi = r.querySelector(".qt-financial_institution");
            const isSel = !!fi && (fi.tagName === "SELECT" || !!fi.querySelector("select"));
            return c
              ? { content: c.slice(0, 24), fi: (fi?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30), isSel }
              : null;
          })
          .filter(Boolean)
          .slice(0, 10),
      };
      for (const row of rows) {
        const txt = row.textContent || "";
        if (!targets.some((t) => txt.includes(t))) continue;
        // どのセルに金融機関が入るか不明なので、全 td とクラス・row生HTMLを出す。
        const cells = Array.from(row.querySelectorAll("td")).map((td) => ({
          cls: td.className || "",
          text: (td.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40),
          hasSelect: !!td.querySelector("select"),
        }));
        const sel = row.querySelector("select");
        const options: Array<{ text: string; selected: boolean }> = [];
        let selectedText = "";
        if (sel) {
          const s = sel as HTMLSelectElement;
          for (const o of Array.from(s.options))
            options.push({ text: (o.textContent || "").trim(), selected: o.selected });
          selectedText = (s.options[s.selectedIndex]?.textContent || "").trim();
        }
        out.push({
          content: (row.querySelector(".content")?.textContent || txt).trim().replace(/\s+/g, " ").slice(0, 30),
          isSelect: !!sel,
          selectedText,
          options,
          cells,
          rowOuter: (row.outerHTML || "").replace(/\s+/g, " ").slice(0, 700),
        });
      }
      return { url: location.href, out, diag };
    });

    console.log("URL:", data.url);
    console.log("診断:", JSON.stringify(data.diag, null, 2));
    for (const r of data.out) {
      console.log(`\n--- ${r.content} ---`);
      console.log("  isSelect:", r.isSelect, "| selectedText:", JSON.stringify(r.selectedText));
      console.log("  options:", JSON.stringify(r.options));
      console.log("  cells:", JSON.stringify(r.cells, null, 1));
      console.log("  rowOuter:", r.rowOuter);
    }
    if (data.out.length === 0) console.log("(対象取引が見つかりませんでした)");
  });
}

const mode = process.argv[2];
const run = mode === "portfolio" ? portfolio : mode === "cf-select" ? cfSelect : null;
if (!run) {
  console.error("usage: npx tsx scripts/inspect-mf.ts <portfolio|cf-select>");
  process.exit(1);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
