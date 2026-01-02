// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      3.17
// @description  Money Forward MEのデータをGASへ自動同期します。(URL強制遷移/ページリロード型)
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

    // --- 永続化ステート管理用キー ---
    const KEY_SYNC_MODE = 'MF_SYNC_MODE';   // 'running' or null
    const KEY_SYNC_QUEUE = 'MF_SYNC_QUEUE'; // Array of {year, month}
    const KEY_SYNC_DATA = 'MF_SYNC_DATA';   // Array of scraped data

    // --- スタイル設定 ---
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
            #mf-sync-status.hidden {
                opacity: 0;
                pointer-events: none;
            }
            #mf-sync-status.error {
                background: rgba(200, 0, 0, 0.9);
            }
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

        if (duration > 0) {
            setTimeout(() => {
                el.classList.add('hidden');
            }, duration);
        }
    };

    // --- ユーティリティ ---
    const promptAndSetGasUrl = async () => {
        const currentUrl = await GM_getValue('GAS_URL', '');
        const newUrl = prompt('GASのウェブアプリURLを入力してください(execで終わるもの):', currentUrl);
        if (newUrl) {
            if (!newUrl.includes('/exec')) {
                alert('警告: URLの末尾が "/exec" ではないようです。\n正しい「ウェブアプリURL」かどうか確認してください。');
            }
            await GM_setValue('GAS_URL', newUrl);
            showStatus('GAS URLを保存しました', 3000);
            return newUrl;
        }
        return null;
    };

    const gmFetch = (url, options) => {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url: url,
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                data: options.body,
                anonymous: true,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        reject(new Error(`HTTP Error: ${response.status} ${response.statusText}`));
                    }
                },
                onerror: (err) => reject(new Error("Network Error"))
            });
        });
    };

    const fetchWithRetry = async (url, options, retries = 3, delay = 3000) => {
        for (let i = 0; i < retries; i++) {
            try {
                return await gmFetch(url, options);
            } catch (error) {
                console.warn(`Sync retry ${i + 1}/${retries}: ${error.message}`);
                showStatus(`通信エラー... リトライ中 (${i + 1}/${retries})`);
                if (i === retries - 1) throw error;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    };

    // --- メイン処理 (ステートマシン型) ---
    async function processSyncQueue() {
        const mode = await GM_getValue(KEY_SYNC_MODE, null);
        if (mode !== 'running') return;

        showStatus("同期プロセス実行中...");

        // キューとデータを確認
        let queue = JSON.parse(await GM_getValue(KEY_SYNC_QUEUE, '[]'));
        let collectedData = JSON.parse(await GM_getValue(KEY_SYNC_DATA, '[]'));

        if (queue.length === 0) {
            // 全て完了 -> 送信処理へ
            await finalizeSync(collectedData);
            return;
        }

        const currentTarget = queue[0]; // {year: 2024, month: 1}

        // 現在のURLがターゲットと一致するか確認
        const currentParams = new URLSearchParams(window.location.search);
        const isUrlMatched = (
            currentParams.get('year') == currentTarget.year &&
            currentParams.get('month') == currentTarget.month
        );

        if (!isUrlMatched) {
            console.log(`【Navigation】Moving to target: ${currentTarget.year}/${currentTarget.month}`);
            const nextUrl = new URL(window.location.href);
            nextUrl.pathname = '/cf'; // 詳細一覧ページパスを強制
            nextUrl.searchParams.set('year', currentTarget.year);
            nextUrl.searchParams.set('month', currentTarget.month);

            // ページ遷移 (ここでスクリプトは終了し、ロード後に再開)
            window.location.href = nextUrl.toString();
            return;
        }

        // URLが一致する場合 -> スクレイピング実行
        showStatus(`同期中: ${currentTarget.year}年${currentTarget.month}月 (残り${queue.length}ヶ月)`);

        // テーブル待機
        let activeSelector = null;
        try {
            const result = await waitForSyncTarget(5000);
            activeSelector = result.selector;
        } catch (e) {
            console.warn("明細テーブルが見つかりません (データ0件の可能性)");
        }

        if (activeSelector) {
            const currentBody = document.querySelector(activeSelector);
            // URL由来の年(currentTarget.year)を正として使用
            const pageData = scrapeFromElement(currentBody, currentTarget.year.toString());
            console.log(`【Scrape】${currentTarget.year}/${currentTarget.month}: ${pageData.length} items found.`);

            // データを結合
            collectedData.push(...pageData);
        } else {
            console.log(`【Scrape】${currentTarget.year}/${currentTarget.month}: No table found (0 items).`);
        }

        // 処理完了した月をキューから削除して保存
        queue.shift();
        await GM_setValue(KEY_SYNC_QUEUE, JSON.stringify(queue));
        await GM_setValue(KEY_SYNC_DATA, JSON.stringify(collectedData));

        // 次のステップへ (ページ遷移が必要なので次のループで処理)
        setTimeout(() => {
            processSyncQueue();
        }, 1000);
    }

    const waitForSyncTarget = (timeout = 6000) => {
        const TARGET_SELECTORS = [
            '#cf-detail-table tbody',
            '#cf-detail-table',
            'section.transaction-section',
            '#transaction_list_body',
            '.js-transaction_table tbody',
            'table.transaction_table tbody'
        ];

        return new Promise((resolve, reject) => {
            const find = () => {
                for (const selector of TARGET_SELECTORS) {
                    const el = document.querySelector(selector);
                    if (el) return { el, selector };
                }
                return null;
            };
            if (find()) return resolve(find());

            const startTime = Date.now();
            const observer = new MutationObserver(() => {
                if (find()) { observer.disconnect(); resolve(find()); }
                else if (Date.now() - startTime > timeout) { observer.disconnect(); reject(new Error("Timeout")); }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); if (find()) resolve(find()); else reject(new Error("Timeout")); }, timeout);
        });
    };

    // スクレイピング関数 (yearOverride対応)
    const scrapeFromElement = (element, yearOverride) => {
        const rows = element.querySelectorAll('tr');
        const data = [];
        const pageYear = yearOverride;

        rows.forEach(row => {
            const getText = (cls) => row.querySelector(`.${cls}`)?.innerText.trim();
            const cells = row.querySelectorAll('td');

            let dateRaw = getText('date');
            let content = getText('content');
            let amountRaw = getText('amount');
            let source = getText('qt-financial_institution');
            let category = "";

            if ((!dateRaw || !content || !amountRaw) && cells.length >= 6) {
                if (!dateRaw) dateRaw = cells[0]?.innerText.trim();
                if (!content) content = cells[1]?.innerText.trim();
                if (!amountRaw) amountRaw = cells[2]?.querySelector('span')?.innerText.trim() || cells[2]?.innerText.trim();
            }
            if (!source && cells.length > 4) source = cells[4]?.innerText.trim();

            const catLarge = getText('qt-large_category') || (cells.length > 5 ? cells[5]?.innerText.trim() : "");
            const catMiddle = getText('qt-middle_category') || (cells.length > 6 ? cells[6]?.innerText.trim() : "");
            category = [catLarge, catMiddle].filter(c => c).join("/");

            if (dateRaw && content && amountRaw) {
                let date = dateRaw;
                const dateMatch = dateRaw.match(/(\d{1,2})\s*[\/／]\s*(\d{1,2})/);
                if (dateMatch) {
                    const m = dateMatch[1].padStart(2, '0');
                    const d = dateMatch[2].padStart(2, '0');
                    date = `${pageYear}/${m}/${d}`;
                }
                const amount = amountRaw.replace(/[,円\s]/g, '');
                const uniqueString = `${date}-${content}-${amount}-${source}-${category}`;
                const hashId = CryptoJS.SHA256(uniqueString).toString(CryptoJS.enc.Hex);
                data.push({ ID: hashId, date, content, amount, source, category });
            }
        });
        return data;
    };

    // 同期完了処理
    async function finalizeSync(allData) {
        showStatus("データ全取得完了。送信準備中...");
        await GM_setValue(KEY_SYNC_MODE, null);
        await GM_setValue(KEY_SYNC_QUEUE, '[]');
        await GM_setValue(KEY_SYNC_DATA, '[]');

        const uniqueData = allData.filter((v, i, a) => a.findIndex(t => t.ID === v.ID) === i);
        showStatus(`${uniqueData.length}件のデータをGASへ送信中...`);

        const gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            alert("GAS URL未設定でした。データ取得までは成功しました。");
            return;
        }

        try {
            const resSync = await fetchWithRetry(gasUrl, {
                method: "POST",
                body: JSON.stringify({ action: "sync_data", data: uniqueData })
            });
            let result;
            try {
                result = JSON.parse(resSync.responseText);
            } catch (e) {
                throw new Error("GAS Response Parse Error");
            }
            if (result.status === 'error') throw new Error(result.message);
            showStatus(`同期完了！ ${result.count}件の更新`, 5000);
            alert(`同期完了！\n${result.count}件のデータを更新しました。`);
        } catch (e) {
            console.error(e);
            showStatus(`送信エラー: ${e.message}`, 0, true);
            alert(`送信エラー: ${e.message}`);
        }
    }

    // 初期化・開始関数
    async function startSync(forceFull = false) {
        if (!confirm("同期を開始しますか？\n(ページ読み込みを繰り返してデータを取得します)")) return;

        let gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            gasUrl = await promptAndSetGasUrl();
            if (!gasUrl) return;
        }

        try {
            showStatus("設定確認中... (しばらくお待ちください)");

            // 設定確認は行いますが、モードは「手動実行」の意図を最優先します
            const resConfig = await fetchWithRetry(gasUrl, {
                method: "POST",
                body: JSON.stringify({ action: "get_sync_config" })
            });

            let config;
            try {
                config = JSON.parse(resConfig.responseText);
            } catch (e) {
                config = { mode: "Incremental" };
            }

            const TARGET_START_YEAR = 2021;
            const TARGET_START_MONTH = 10;
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth() + 1;

            let monthsToSync = 6;

            // forceFullが指定された場合のみ、期間計算を行う（メニューの「通常同期」はGAS設定無視で6ヶ月固定）
            if (forceFull) {
                monthsToSync = (currentYear - TARGET_START_YEAR) * 12 + (currentMonth - TARGET_START_MONTH) + 1;
                monthsToSync = Math.max(monthsToSync, 6);
            } else if (config.mode === 'Full') {
                console.log("GAS Config requested Full sync, but running inside manual 'Normal' mode (6 months).");
            }

            console.log(`【Plan】Syncing ${monthsToSync} months based on End Date: ${currentYear}/${currentMonth}`);

            // キュー作成 (現在 -> 過去)
            const queue = [];
            for (let i = 0; i < monthsToSync; i++) {
                let y = currentYear;
                let m = currentMonth - i;
                while (m < 1) { m += 12; y--; }
                queue.push({ year: y, month: m });
            }

            await GM_setValue(KEY_SYNC_MODE, 'running');
            await GM_setValue(KEY_SYNC_QUEUE, JSON.stringify(queue));
            await GM_setValue(KEY_SYNC_DATA, '[]');

            // プロセス開始
            processSyncQueue();

        } catch (e) {
            alert("開始時エラー: " + e.message);
        }
    }

    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);
    GM_registerMenuCommand('強制フル同期 (2021/10〜)', () => startSync(true));
    GM_registerMenuCommand('通常同期を開始', () => startSync(false));

    GM_registerMenuCommand('同期プロセスをリセット(停止)', async () => {
        await GM_setValue(KEY_SYNC_MODE, null);
        await GM_setValue(KEY_SYNC_QUEUE, '[]');
        location.reload();
    });

    try {
        addStyles();
        const mode = await GM_getValue(KEY_SYNC_MODE);
        if (mode === 'running') {
            processSyncQueue();
        }
    } catch (e) {
        console.error("Critical Error", e);
    }
})();