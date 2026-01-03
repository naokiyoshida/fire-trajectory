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
    // ==========================================
    //  ユーザー設定 / デバッグ設定
    // ==========================================

    // --- モード切替 ---
    const ENABLE_DEBUG_CONFIG = false; // trueにするとデバッグ設定を使用

    // 本番環境用設定
    const CONFIG_PROD = {
        SYNC_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24時間
        INCREMENTAL_MONTHS: 6,
        START_YEAR: 2021,
        START_MONTH: 10,
        RETRY_LIMIT: 40,
        RETRY_INTERVAL_MS: 500,
        AUTO_CHECK_LIMIT: 50,
        AUTO_CHECK_INTERVAL_MS: 200,
        AUTO_CLOSE_WAIT_MS: 3000
    };

    // デバッグ用設定 (高速動作・テスト用)
    const CONFIG_DEBUG = {
        SYNC_INTERVAL_MS: 5000, // 5秒 (リロード連打テスト用)
        INCREMENTAL_MONTHS: 2,  // 期間短縮
        START_YEAR: 2024,
        START_MONTH: 1,
        RETRY_LIMIT: 20,
        RETRY_INTERVAL_MS: 200, // 高速リトライ
        AUTO_CHECK_LIMIT: 20,
        AUTO_CHECK_INTERVAL_MS: 100,
        AUTO_CLOSE_WAIT_MS: 1000
    };

    const CONFIG = ENABLE_DEBUG_CONFIG ? CONFIG_DEBUG : CONFIG_PROD;

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
        let hasClickedToday = false;

        const checkReady = setInterval(async () => {
            const table = document.querySelector('#cf-detail-table, #transaction_list_body, .js-transaction_table');
            const headerTitle = document.querySelector('.fc-header-title, .transaction-range-display')?.innerText || "";

            // ヘッダーの日付チェック関数 (YYYY年MM月 または YYYY/MM/DD 形式に対応)
            // 戻り値: マッチすればtrue, マッチしなければfalse (ただしnullの場合はfalse)
            const checkHeaderDate = (text, tYear, tMonth) => {
                if (!text) return false;
                const match = text.match(/(\d{4})\s*[\/.年]\s*(\d{1,2})/);
                if (match) {
                    const y = parseInt(match[1], 10);
                    const m = parseInt(match[2], 10);
                    return y === tYear && m === tMonth;
                }
                return text.includes(`${tMonth}月`);
            };

            const isMatch = checkHeaderDate(headerTitle, targetYear, targetMonth);

            if (table && isMatch) {
                clearInterval(checkReady);
                runSyncFlow(forceFull, isAuto);
            } else if (table && headerTitle) {
                // マッチしない場合、ユーザ提案の「今月ボタン」を試す (ある程度待ってから)
                if (!isMatch && !hasClickedToday && checkRetry > 5) {
                    const todayBtn = document.querySelector('button.fc-button-today, .fc-today-button');
                    if (todayBtn && !todayBtn.disabled) {
                        console.log("MF Sync: Date mismatch - clicking 'Today' button.");
                        todayBtn.click();
                        hasClickedToday = true;
                    }
                }
                console.log(`MF Sync: Waiting for month match. Expected: ${targetYear}/${targetMonth}, Got: ${headerTitle}`);
            }

            if (++checkRetry > CONFIG.AUTO_CHECK_LIMIT) {
                console.warn("MF Sync: Time out or Month mismatch.");
                clearInterval(checkReady);

                if (headerTitle && !isMatch) {
                    console.error(`MF Sync: Fatal - Page content (${headerTitle}) does not match URL target (${targetYear}/${targetMonth}).`);

                    const pendingMode = await GM_getValue('PENDING_SYNC_MODE', '');

                    // すでにリロードを試みた(PENDINGあり)のにまだ不一致の場合、これ以上リダイレクトしても無駄なので諦める
                    // サーバー側がその日付の表示を拒否している（未来日付など）可能性が高い
                    if (pendingMode) {
                        console.warn("MF Sync: Redirect failed to enforce date. Falling back to actual page date.");
                        await GM_setValue('PENDING_SYNC_MODE', ''); // ループ防止のためにフラグ消去

                        // ヘッダーから実際の日付を読み取ってスタートする
                        const match = headerTitle.match(/(\d{4})\s*[\/.年]\s*(\d{1,2})/);
                        if (match) {
                            const actualYear = parseInt(match[1], 10);
                            const actualMonth = parseInt(match[2], 10);
                            if (!isAuto) alert(`指定された ${targetYear}/${targetMonth} に移動できませんでした。\n現在表示されている ${actualYear}/${actualMonth} から同期を開始します。`);
                            runSyncFlow(forceFull, isAuto, actualYear, actualMonth);
                            return;
                        }
                    }

                    // まだリロードしていない、あるいは初回トライの場合はリロードを試みる
                    if (isAuto || pendingMode) {
                        // キャッシュバスターをつけてリロード
                        const newUrl = `https://moneyforward.com/cf?year=${targetYear}&month=${targetMonth}&_t=${Date.now()}`;
                        location.replace(newUrl);
                    } else if (!isAuto) {
                        alert(`ページ内容が ${targetYear}年${targetMonth}月 になりませんでした。\n手動で移動してから再実行してください。`);
                    }
                } else {
                    if (!isAuto) alert("取引テーブルが見つかりませんでした。");
                }
            }
        }, CONFIG.AUTO_CHECK_INTERVAL_MS);
    }

    // --- メイン同期フロー ---
    async function runSyncFlow(forceFull = false, isAuto = false, overrideYear = null, overrideMonth = null) {
        if (isAuto) console.log("MF Sync: Auto-sync starting...");
        isRequestStop = false;

        showStatus("同期準備中...");
        const gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            if (!isAuto) alert("GAS URLを設定してください");
            return;
        }

        const urlParams = new URLSearchParams(window.location.search);
        // オーバーライドがあればそれを優先、なければURLから、それもなければ現在日時
        let logicalYear = overrideYear || parseInt(urlParams.get('year'), 10);
        let logicalMonth = overrideMonth || parseInt(urlParams.get('month'), 10);

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

            // ページ遷移が必要な場合（2ヶ月目以降 or 初回でもoverride等でページが違う場合）
            // ただし初回(i=0)でかつ現在ページが対象月と一致しているなら遷移不要
            // ここではシンプルに「現在のDOMヘッダー」をチェックして、違えば遷移待ちをする、というアプローチ

            // NOTE: runSyncFlowが呼ばれた時点で、i=0のページには居るはず(waitForTableAndRunで保証済)
            // ただしフォールバックの場合はここに居る

            showStatus(`同期中: ${logicalYear}年${logicalMonth}月 (${i + 1}/${monthsToSync})`);

            let retry = 0;
            let pageData = [];
            while (retry < CONFIG.RETRY_LIMIT) {
                if (isRequestStop) return;
                const headerTitle = document.querySelector('.fc-header-title, .transaction-range-display')?.innerText || "";

                // ヘッダー日付判定
                let isCorrectMonthOnPage = false;
                const match = headerTitle.match(/(\d{4})\s*[\/.年]\s*(\d{1,2})/);
                if (match) {
                    const y = parseInt(match[1], 10);
                    const m = parseInt(match[2], 10);
                    isCorrectMonthOnPage = (y === logicalYear && m === logicalMonth);
                } else {
                    isCorrectMonthOnPage = headerTitle.includes(`${logicalMonth}月`);
                }

                pageData = scrapePage(logicalYear, logicalMonth);
                const currentHash = JSON.stringify(pageData.slice(0, 3));

                if (pageData.length > 0 && currentHash !== lastPageHash) {
                    lastPageHash = currentHash;
                    break;
                }

                // データ0件でも、ヘッダーが正しい月なら「データなし」として確定して良い
                // ただしローディング中は待つ
                if (isCorrectMonthOnPage && !document.querySelector('.loading-spinner')) {
                    // 念の為少し待って再取得
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

    GM_registerMenuCommand('【Debug】強制自動同期モード(URLパラメタ擬似)でリロード', async () => {
        await GM_setValue('DEBUG_SIMULATE_SCHEDULER', true);
        location.reload();
    });

    addStyles();
    console.log(`MF Sync: v${GM_info.script.version} ready.`);

    // --- 起動時チェック: 保留中の同期 or オート同期判定 ---
    (async () => {
        const urlParams = new URLSearchParams(window.location.search);

        // デバッグ用フラグのチェック & 消費
        const isDebugScheduler = await GM_getValue('DEBUG_SIMULATE_SCHEDULER', false);
        if (isDebugScheduler) {
            console.log("MF Sync: Debug - Simulating Task Scheduler launch.");
            await GM_setValue('DEBUG_SIMULATE_SCHEDULER', false);
        }

        // タスクスケジューラからの起動判定 (URLパラメータ ?force_auto_sync=true OR Debug Flag)
        const isTaskScheduler = (urlParams.get('force_auto_sync') === 'true') || isDebugScheduler;

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

        console.log(`MF Sync: Auto-sync check. Last sync: ${new Date(lastSync).toLocaleString()}. TaskScheduler: ${isTaskScheduler}`);

        if (isTaskScheduler || forceNext || (now - lastSync > CONFIG.SYNC_INTERVAL_MS)) {
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