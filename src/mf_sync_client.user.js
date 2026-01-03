// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      3.61
// @description  Money Forward MEのデータをGASへ自動同期します。(設定集約/スマート自動実行版)
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

    // ==========================================
    //  ユーザー設定 / デバッグ設定
    // ==========================================
    const CONFIG = {
        // 自動実行の間隔 (ミリ秒)
        // 24時間: 24 * 60 * 60 * 1000
        // テスト時は 5 * 1000 (5秒) などに書き換えるとリロードで即実行されます
        SYNC_INTERVAL_MS: 24 * 60 * 60 * 1000,

        // 通常同期 (Incremental) で遡る月数
        INCREMENTAL_MONTHS: 6,

        // フル同期 (Full) 時の開始年月
        START_YEAR: 2021,
        START_MONTH: 10,

        // ページ読み込み待ちの設定
        RETRY_LIMIT: 40,      // 最大試行回数
        RETRY_INTERVAL_MS: 500, // 試行間隔

        // 自動実行時のテーブル検知設定
        AUTO_CHECK_LIMIT: 50,      // 最大試試行回数
        AUTO_CHECK_INTERVAL_MS: 200, // 試行間隔 (高速検知)

        // 自動実行完了後のタブ閉鎖待ち時間
        AUTO_CLOSE_WAIT_MS: 3000
    };

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
                const isTransfer = row.classList.contains('is-transfer') || amountRaw.includes('(振替)');
                const isExcluded = row.classList.contains('is-calculation-excluded') || row.querySelector('.icon-ban-circle');
                if (isTransfer || isExcluded) return;

                const dateMatch = dateRaw.match(/(\d{1,2})\s*[\/／]\s*(\d{1,2})/);
                if (dateMatch) {
                    const m = dateMatch[1].padStart(2, '0');
                    const d = dateMatch[2].padStart(2, '0');
                    if (parseInt(m, 10) !== parseInt(month, 10)) return;

                    const date = `${year}/${m}/${d}`;
                    const amount = amountRaw.replace(/[,円\s]/g, '').replace(/\(振替\)/, '');
                    const uniqueString = `${date}-${content}-${amount}-${source}-${category}`;
                    const hashId = CryptoJS.SHA256(uniqueString).toString(CryptoJS.enc.Hex);
                    data.push({ ID: hashId, date, content, amount, source, category });
                }
            }
        });
        return data;
    };

    let isRequestStop = false;

    // --- 統一された開始シーケンス (初期化・リダイレクト含む) ---
    async function startSyncSequence(mode) {
        // mode: 'MANUAL' | 'FORCE_FULL' | 'AUTO'
        console.log(`MF Sync: Requesting start sequence (Mode: ${mode})`);

        // 1. カレントページの確認 (必ず「今月」からスタートする)
        const today = new Date();
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth() + 1;
        const targetUrl = `https://moneyforward.com/cf?year=${currentYear}&month=${currentMonth}`;

        const urlParams = new URLSearchParams(window.location.search);
        const paramYear = parseInt(urlParams.get('year'), 10);
        const paramMonth = parseInt(urlParams.get('month'), 10);

        const isCurrentMonth = (paramYear === currentYear && paramMonth === currentMonth);

        // ページが違う場合はリダイレクトを行い、次回のロードで実行する
        if (!isCurrentMonth) {
            console.log(`MF Sync: Redirecting to start page (${currentYear}/${currentMonth})...`);
            await GM_setValue('PENDING_SYNC_MODE', mode);
            location.assign(targetUrl); // historyに残して移動
            return;
        }

        // 2. ページが正しい場合は同期フローを実行
        // PENDINGフラグが生きていたら消しておく
        await GM_setValue('PENDING_SYNC_MODE', '');

        const isAuto = (mode === 'AUTO');
        const forceFull = (mode === 'FORCE_FULL');

        // テーブルの存在チェック & 年月同一性の確認
        waitForTableAndRun(forceFull, isAuto, currentYear, currentMonth);
    }

    function waitForTableAndRun(forceFull, isAuto, targetYear, targetMonth) {
        showStatus("ページ準備中...", 0);
        let checkRetry = 0;
        const checkReady = setInterval(async () => {
            const table = document.querySelector('#cf-detail-table, #transaction_list_body, .js-transaction_table');
            const headerTitle = document.querySelector('.fc-header-title, .transaction-range-display')?.innerText || "";

            // テーブルがあり、かつヘッダーの月がターゲットと一致するか？
            // タイトル例: "2026年1月1日 - 2026年1月31日" や "2026年01月"
            if (table && headerTitle.includes(`${targetMonth}月`)) {
                clearInterval(checkReady);
                runSyncFlow(forceFull, isAuto);
            } else if (table && headerTitle) {
                // テーブルはあるが月が違う場合...もう少し待つ
                console.log(`MF Sync: Waiting for month match. Expected: ${targetMonth}, Got: ${headerTitle}`);
            }

            if (++checkRetry > CONFIG.AUTO_CHECK_LIMIT) {
                console.warn("MF Sync: Time out or Month mismatch.");
                clearInterval(checkReady);

                // もし月が違ってタイムアウトした場合、本当にページ遷移がうまくいっていない可能性がある
                if (headerTitle && !headerTitle.includes(`${targetMonth}月`)) {
                    console.error(`MF Sync: Fatal - Page content (${headerTitle}) does not match URL target (${targetMonth}). Forcing reload.`);
                    if (isAuto || await GM_getValue('PENDING_SYNC_MODE', false)) {
                        // 再度リトライするためにフラグを戻してリロード（無限ループ防止のため回数制限が必要だが、まずは強力に直す）
                        // 念の為キャッシュバスターをつける
                        const newUrl = `https://moneyforward.com/cf?year=${targetYear}&month=${targetMonth}&_t=${Date.now()}`;
                        location.replace(newUrl);
                    } else if (!isAuto) {
                        alert(`ページ内容が${targetMonth}月になりませんでした。\n手動で${targetMonth}月に移動してから再実行してください。`);
                    }
                } else {
                    if (!isAuto) alert("取引テーブルが見つかりませんでした。");
                }
            }
        }, CONFIG.AUTO_CHECK_INTERVAL_MS);
    }

    // --- メイン同期フロー ---
    async function runSyncFlow(forceFull = false, isAuto = false) {
        if (isAuto) console.log("MF Sync: Auto-sync starting...");
        isRequestStop = false;

        showStatus("同期準備中...");
        const gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            if (!isAuto) alert("GAS URLを設定してください");
            return;
        }

        const urlParams = new URLSearchParams(window.location.search);
        let logicalYear = parseInt(urlParams.get('year'), 10);
        let logicalMonth = parseInt(urlParams.get('month'), 10);

        // URLパラメータが不正(または無い)場合は現在年月で補完
        if (isNaN(logicalYear) || isNaN(logicalMonth)) {
            const now = new Date();
            logicalYear = now.getFullYear();
            logicalMonth = now.getMonth() + 1;
        }

        let monthsToSync = CONFIG.INCREMENTAL_MONTHS;
        let isFullMode = false;
        try {
            const res = await gmFetch(gasUrl, { method: "POST", body: JSON.stringify({ action: "get_sync_config" }) });
            const config = JSON.parse(res.responseText);
            if (forceFull || config.mode === 'Full') {
                isFullMode = true;
                monthsToSync = (logicalYear - CONFIG.START_YEAR) * 12 + (logicalMonth - CONFIG.START_MONTH) + 1;
                monthsToSync = Math.max(monthsToSync, CONFIG.INCREMENTAL_MONTHS);
            } else {
                monthsToSync = CONFIG.INCREMENTAL_MONTHS;
            }
        } catch (e) {
            console.warn("GAS Config failed, defaulting...", e);
        }

        if (!isAuto) {
            const modeText = isFullMode ? `全期間（${CONFIG.START_YEAR}/${CONFIG.START_MONTH}〜）` : `直近${CONFIG.INCREMENTAL_MONTHS}ヶ月分`;
            if (!confirm(`${logicalYear}年${logicalMonth}月から遡って ${modeText} のデータを同期しますか？\n(画面を閉じたり操作したりしないでください)`)) return;
        }

        let allCollectedData = [];
        let lastPageHash = "";

        for (let i = 0; i < monthsToSync; i++) {
            if (isRequestStop) {
                showStatus("同期を中断しました", 3000, true);
                return;
            }

            showStatus(`同期中: ${logicalYear}年${logicalMonth}月 (${i + 1}/${monthsToSync})`);

            let retry = 0;
            let pageData = [];
            while (retry < CONFIG.RETRY_LIMIT) {
                if (isRequestStop) return;
                const headerTitle = document.querySelector('.fc-header-title, .transaction-range-display')?.innerText || "";
                const isCorrectMonthOnPage = headerTitle.includes(`${logicalMonth}月`);

                pageData = scrapePage(logicalYear, logicalMonth);
                const currentHash = JSON.stringify(pageData.slice(0, 3));

                if (pageData.length > 0 && currentHash !== lastPageHash) {
                    lastPageHash = currentHash;
                    break;
                }
                if (isCorrectMonthOnPage && !document.querySelector('.loading-spinner')) {
                    await new Promise(r => setTimeout(r, 500));
                    pageData = scrapePage(logicalYear, logicalMonth);
                    break;
                }
                await new Promise(r => setTimeout(r, CONFIG.RETRY_INTERVAL_MS));
                retry++;
            }

            console.log(`【Scrape】${logicalYear}/${logicalMonth}: ${pageData.length} items found.`);
            allCollectedData.push(...pageData);

            if (i < monthsToSync - 1) {
                const prevBtn = document.querySelector('button.fc-button-prev, .fc-button-prev, #menu_range_prev, .previous_month a');
                if (prevBtn) {
                    prevBtn.click();
                    logicalMonth--;
                    if (logicalMonth < 1) { logicalMonth = 12; logicalYear--; }
                    await new Promise(r => setTimeout(r, 800));
                } else {
                    console.error("前月ボタンが見つかりません。中断します。");
                    break;
                }
            }
        }

        if (allCollectedData.length > 0) {
            showStatus(`${allCollectedData.length}件を送信中...`);
            const uniqueData = allCollectedData.filter((v, i, a) => a.findIndex(t => t.ID === v.ID) === i);
            try {
                const res = await gmFetch(gasUrl, { method: "POST", body: JSON.stringify({ action: "sync_data", data: uniqueData }) });
                const result = JSON.parse(res.responseText);
                showStatus(`完了: ${result.count}件`, 5000);
                await GM_setValue('LAST_SYNC_TIME', Date.now());

                if (isAuto) {
                    showStatus(`同期完了。${CONFIG.AUTO_CLOSE_WAIT_MS / 1000}秒後にタブを閉じます...`, CONFIG.AUTO_CLOSE_WAIT_MS);
                    setTimeout(() => {
                        window.close();
                    }, CONFIG.AUTO_CLOSE_WAIT_MS);
                } else {
                    alert(`同期完了！\n${result.count}件の新規取引を保存しました。`);
                }
            } catch (e) {
                if (!isAuto) alert("送信エラー: " + e.message);
                showStatus("Error", 5000, true);
            }
        } else {
            if (!isAuto) alert("同期対象のデータが見つかりませんでした。");
        }
    }

    const promptAndSetGasUrl = async () => {
        const currentUrl = await GM_getValue('GAS_URL', '');
        const newUrl = prompt('GAS URLを入力:', currentUrl);
        if (newUrl) { await GM_setValue('GAS_URL', newUrl); location.reload(); }
    };

    // --- メニューコマンド登録 ---
    // startSyncSequence を経由させることで、必ず今月のページに移動してから開始する
    GM_registerMenuCommand('手動同期を開始 (今月から)', () => startSyncSequence('MANUAL'));
    GM_registerMenuCommand('強制フル同期 (2021/10〜)', () => startSyncSequence('FORCE_FULL'));
    GM_registerMenuCommand('同期を停止', () => { isRequestStop = true; showStatus("停止リクエスト送信済み..."); });
    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);
    GM_registerMenuCommand('【Debug】次回の読込時に強制同期', async () => {
        await GM_setValue('DEBUG_FORCE_NEXT_SYNC', true);
        alert("設定しました。ページをリロードすると同期が開始されます。");
    });

    addStyles();
    console.log(`MF Sync: v${GM_info.script.version} ready.`);

    // --- 起動時チェック: 保留中の同期 or オート同期判定 ---
    (async () => {
        // 1. 保留中の同期があるか？ (リダイレクト復帰など)
        const pendingMode = await GM_getValue('PENDING_SYNC_MODE', '');
        if (pendingMode) {
            console.log(`MF Sync: Resuming pending sync mode: ${pendingMode}`);
            await startSyncSequence(pendingMode);
            return;
        }

        // 2. オート同期の判定
        const lastSync = await GM_getValue('LAST_SYNC_TIME', 0);
        const forceNext = await GM_getValue('DEBUG_FORCE_NEXT_SYNC', false);
        const now = Date.now();

        console.log(`MF Sync: Auto-sync check. Last sync: ${new Date(lastSync).toLocaleString()}.`);

        if (forceNext || (now - lastSync > CONFIG.SYNC_INTERVAL_MS)) {
            console.log("MF Sync: Auto-sync condition met.");
            if (forceNext) await GM_setValue('DEBUG_FORCE_NEXT_SYNC', false);

            // startSyncSequence('AUTO') を呼ぶことで、必要ならリダイレクトされる
            await startSyncSequence('AUTO');
        } else {
            const nextSync = new Date(lastSync + CONFIG.SYNC_INTERVAL_MS);
            console.log(`MF Sync: Auto-sync skipped. Next sync after: ${nextSync.toLocaleString()}`);
        }
    })();
})();