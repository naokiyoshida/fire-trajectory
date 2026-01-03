// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      3.22
// @description  Money Forward MEのデータをGASへ自動同期します。(SPAボタン連打/論理カウンター版)
// @author       Naoki Yoshida
// @match        https://moneyforward.com/cf*
// @downloadURL  https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @updateURL    https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(async function () {
    'use strict';

    // --- 設定・ステート ---
    const addStyles = () => {
        const style = document.createElement('style');
        style.textContent = `
            #mf-sync-status {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 10px 15px;
                border-radius: 5px;
                z-index: 9999;
                font-family: sans-serif;
                font-size: 14px;
                transition: opacity 0.5s;
                max-width: 300px;
            }
            #mf-sync-status.hidden { opacity: 0; pointer-events: none; }
            #mf-sync-status.error { background: rgba(200, 0, 0, 0.9); }
        `;
        document.head.appendChild(style);
    };

    const showStatus = (message, duration = 0, isError = false) => {
        let el = document.getElementById('mf-sync-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mf-sync-status';
            document.body.appendChild(el);
        }
        el.innerText = message;
        el.classList.remove('hidden');
        if (isError) el.classList.add('error');
        else el.classList.remove('error');
        if (duration > 0) setTimeout(() => el.classList.add('hidden'), duration);
    };

    const gmFetch = (url, options) => {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                data: options.body,
                anonymous: true,
                onload: (res) => (res.status >= 200 && res.status < 300) ? resolve(res) : reject(new Error(`HTTP ${res.status}`)),
                onerror: () => reject(new Error("Network Error"))
            });
        });
    };

    // --- スクレイピング核となる関数 ---
    const scrapePage = (year, month) => {
        const targetSelectors = ['#cf-detail-table tbody', '#transaction_list_body', '.js-transaction_table tbody'];
        let element = null;
        for (const sel of targetSelectors) {
            element = document.querySelector(sel);
            if (element) break;
        }
        if (!element) return [];

        const rows = element.querySelectorAll('tr');
        const data = [];
        rows.forEach(row => {
            const getText = (cls) => row.querySelector(`.${cls}`)?.innerText.trim();
            const cells = row.querySelectorAll('td');

            let dateRaw = getText('date') || cells[0]?.innerText.trim();
            let content = getText('content') || cells[1]?.innerText.trim();
            let amountRaw = getText('amount') || cells[2]?.querySelector('span')?.innerText.trim() || cells[2]?.innerText.trim();
            let source = getText('qt-financial_institution') || (cells.length > 4 ? cells[4]?.innerText.trim() : "");

            const catLarge = getText('qt-large_category') || (cells.length > 5 ? cells[5]?.innerText.trim() : "");
            const catMiddle = getText('qt-middle_category') || (cells.length > 6 ? cells[6]?.innerText.trim() : "");
            const category = [catLarge, catMiddle].filter(c => c).join("/");

            if (dateRaw && content && amountRaw) {
                const dateMatch = dateRaw.match(/(\d{1,2})\s*[\/／]\s*(\d{1,2})/);
                if (dateMatch) {
                    const m = dateMatch[1].padStart(2, '0');
                    const d = dateMatch[2].padStart(2, '0');

                    // 論理チェック: 画面上の月が、私たちが期待している月と一致する場合のみ採用
                    // (SPAの反映遅れによる二重取得防止)
                    if (parseInt(m, 10) !== parseInt(month, 10)) return;

                    const date = `${year}/${m}/${d}`;
                    const amount = amountRaw.replace(/[,円\s]/g, '');
                    const uniqueString = `${date}-${content}-${amount}-${source}-${category}`;
                    const hashId = CryptoJS.SHA256(uniqueString).toString(CryptoJS.enc.Hex);
                    data.push({ ID: hashId, date, content, amount, source, category });
                }
            }
        });
        return data;
    };

    // --- メイン同期ループ (SPA) ---
    async function runSyncFlow(forceFull = false) {
        showStatus("同期準備中...");
        const gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) { alert("GAS URLを設定してください"); return; }

        // 1. スタート地点の確定
        const urlParams = new URLSearchParams(window.location.search);
        let logicalYear = parseInt(urlParams.get('year'), 10);
        let logicalMonth = parseInt(urlParams.get('month'), 10);

        if (isNaN(logicalYear) || isNaN(logicalMonth)) {
            const now = new Date();
            logicalYear = now.getFullYear(); // ユーザーPCの 2026
            logicalMonth = now.getMonth() + 1;
            console.log(`【Start】No URL params. Starting from system date: ${logicalYear}/${logicalMonth}`);
        } else {
            console.log(`【Start】Starting from URL params: ${logicalYear}/${logicalMonth}`);
        }

        // 2. 期間の確定
        let monthsToSync = 6;
        try {
            const res = await gmFetch(gasUrl, { method: "POST", body: JSON.stringify({ action: "get_sync_config" }) });
            const config = JSON.parse(res.responseText);
            // 手動で「通常同期」を選んだ場合は、GAS側がFullを求めていても6ヶ月を優先する
            if (forceFull) {
                monthsToSync = (logicalYear - 2021) * 12 + (logicalMonth - 10) + 1;
                monthsToSync = Math.max(monthsToSync, 6);
            } else if (config.mode === 'Full') {
                console.log("GAS Config suggested Full sync, but respecting manual 'Normal Sync' (6 months).");
            }
        } catch (e) { console.warn("GAS Config failed", e); }

        if (!confirm(`${logicalYear}年${logicalMonth}月から遡って ${monthsToSync}ヶ月分 のデータを同期しますか？\n(画面を閉じたり操作したりしないでください)`)) return;

        let allCollectedData = [];
        let lastPageHash = "";

        for (let i = 0; i < monthsToSync; i++) {
            showStatus(`同期中: ${logicalYear}年${logicalMonth}月 (${i + 1}/${monthsToSync})`);

            // 画面が切り替わるのを待つ (最大10秒)
            let retry = 0;
            let pageData = [];
            while (retry < 20) {
                const headerTitle = document.querySelector('.fc-header-title, .transaction-range-display')?.innerText || "";
                const isCorrectMonthOnPage = headerTitle.includes(`${logicalMonth}月`);

                pageData = scrapePage(logicalYear, logicalMonth);
                const currentHash = JSON.stringify(pageData.slice(0, 3));

                // 1. データがあり、かつ前回と指紋が違うことが確認できればOK
                if (pageData.length > 0 && currentHash !== lastPageHash) {
                    lastPageHash = currentHash;
                    break;
                }

                // 2. データが0件の場合でも、ヘッダーの表示が「期待する月」に切り替わっており、
                // かつ読み込み中スピナーがなければ、本当に0件の月として確定
                if (isCorrectMonthOnPage && !document.querySelector('.loading-spinner')) {
                    // 念のため少し追加で待ってから確定
                    await new Promise(r => setTimeout(r, 500));
                    pageData = scrapePage(logicalYear, logicalMonth);
                    break;
                }

                await new Promise(r => setTimeout(r, 500));
                retry++;
            }

            console.log(`【Scrape】${logicalYear}/${logicalMonth}: ${pageData.length} items found. (Wait: ${retry * 500}ms)`);
            allCollectedData.push(...pageData);

            // 「前月」ボタンを押す
            if (i < monthsToSync - 1) {
                const prevBtn = document.querySelector('button.fc-button-prev, .fc-button-prev, #menu_range_prev, .previous_month a');
                if (prevBtn) {
                    prevBtn.click();
                    // カウンター更新
                    logicalMonth--;
                    if (logicalMonth < 1) { logicalMonth = 12; logicalYear--; }
                    // 読み込み待ち
                    await new Promise(r => setTimeout(r, 800));
                } else {
                    console.error("前月ボタンが見つかりません。中断します。");
                    break;
                }
            }
        }

        // 3. 送信
        if (allCollectedData.length > 0) {
            showStatus(`${allCollectedData.length}件を送信中...`);
            const uniqueData = allCollectedData.filter((v, i, a) => a.findIndex(t => t.ID === v.ID) === i);
            try {
                const res = await gmFetch(gasUrl, { method: "POST", body: JSON.stringify({ action: "sync_data", data: uniqueData }) });
                const result = JSON.parse(res.responseText);
                alert(`同期完了！\n${result.count}件の取引を保存しました。`);
                showStatus(`完了: ${result.count}件`, 5000);
            } catch (e) {
                alert("送信エラー: " + e.message);
                showStatus("Error", 5000, true);
            }
        } else {
            alert("同期対象のデータが見つかりませんでした。");
        }
    }

    // --- メニュー ---
    const promptAndSetGasUrl = async () => {
        const currentUrl = await GM_getValue('GAS_URL', '');
        const newUrl = prompt('GAS URLを入力:', currentUrl);
        if (newUrl) { await GM_setValue('GAS_URL', newUrl); location.reload(); }
    };

    GM_registerMenuCommand('通常同期を開始', () => runSyncFlow(false));
    GM_registerMenuCommand('強制フル同期 (2021/10〜)', () => runSyncFlow(true));
    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);

    addStyles();
    console.log("MF Sync: Logical SPA mode ready.");
})();