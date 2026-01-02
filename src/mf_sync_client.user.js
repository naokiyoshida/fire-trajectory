// ==UserScript==
// @name         fire-trajectory-sync-client
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Money Forward MEのデータをGASへ自動同期します。Adaptive Syncにより初回52ヶ月/通常6ヶ月を自動判別。
// @author       Naoki Yoshida
// @match        https://moneyforward.com/cf*
// @downloadURL  https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @updateURL    https://raw.githubusercontent.com/naokiyoshida/fire-trajectory/main/src/mf_sync_client.user.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // スタイル設定（ステータス表示用）
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
        `;
        document.head.appendChild(style);
    };

    // ステータス表示
    const showStatus = (message, duration = 0) => {
        let el = document.getElementById('mf-sync-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'mf-sync-status';
            document.body.appendChild(el);
        }
        el.innerText = message;
        el.classList.remove('hidden');
        if (duration > 0) {
            setTimeout(() => {
                el.classList.add('hidden');
            }, duration);
        }
    };

    // GAS URLを設定する関数
    const promptAndSetGasUrl = async () => {
        const currentUrl = await GM_getValue('GAS_URL', '');
        const newUrl = prompt('GASのデプロイメントURLを入力してください:', currentUrl);
        if (newUrl) {
            await GM_setValue('GAS_URL', newUrl);
            showStatus('GAS URLを保存しました', 3000);
            return newUrl;
        }
        return null;
    };

    // Tampermonkeyメニューに設定コマンドを登録
    GM_registerMenuCommand('GAS URLを再設定', promptAndSetGasUrl);

    // 指定された要素が消えるまで待つ関数
    const waitForElementToDisappear = (...selectors) => {
        return new Promise(resolve => {
            const check = () => !selectors.some(s => document.querySelector(s));
            if (check()) return resolve();

            const observer = new MutationObserver(() => {
                if (check()) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    };

    // リトライ機能付きのfetch関数
    const fetchWithRetry = async (url, options, retries = 3, delay = 3000) => {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url, options);
                if (!response.ok) throw new Error(`Status ${response.status}`);
                return response;
            } catch (error) {
                console.warn(`Sync retry ${i + 1}/${retries}: ${error.message}`);
                showStatus(`通信エラー... リトライ中 (${i + 1}/${retries})`);
                if (i === retries - 1) throw error;
                await new Promise(r => setTimeout(r, delay));
            }
        }
    };

    // 複数のセレクタを試して要素を探す関数
    const waitForSyncTarget = (timeout = 10000) => {
        const TARGET_SELECTORS = [
            '#transaction_list_body',       // オリジナル
            '.js-transaction_table tbody',  // クラスベース
            'table.transaction_table tbody', // 構造ベース
            'section.transaction-section'   // セクション全体
        ];

        return new Promise((resolve, reject) => {
            const find = () => {
                for (const selector of TARGET_SELECTORS) {
                    const el = document.querySelector(selector);
                    if (el) return { el, selector };
                }
                return null;
            };

            const found = find();
            if (found) return resolve(found);

            const startTime = Date.now();
            const observer = new MutationObserver(() => {
                const found = find();
                if (found) {
                    observer.disconnect();
                    resolve(found);
                } else if (Date.now() - startTime > timeout) {
                    observer.disconnect();
                    reject(new Error(`Timeout waiting for targets: ${TARGET_SELECTORS.join(', ')}`));
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                observer.disconnect();
                const found = find();
                if (found) resolve(found);
                else reject(new Error(`Timeout waiting for targets: ${TARGET_SELECTORS.join(', ')}`));
            }, timeout);
        });
    };

    // DOM診断用関数
    const diagnoseDOM = () => {
        console.group("【fire-trajectory】DOM診断レポート");
        console.log("URL:", window.location.href);
        console.log("Tables found:", document.querySelectorAll('table').length);
        document.querySelectorAll('table').forEach((t, i) => {
            console.log(`Table[${i}]: id="${t.id}", class="${t.className}"`);
        });
        console.log("Main content check:", document.querySelector('#main') ? "Found" : "Not Found");
        console.groupEnd();
    };

    async function runSync() {
        showStatus("同期プロセスを開始...");
        console.log("【fire-trajectory】同期プロセスを開始します...");

        let gasUrl = await GM_getValue('GAS_URL');
        if (!gasUrl) {
            showStatus("GAS URL未設定。設定が必要です...");
            await new Promise(r => setTimeout(r, 500));
            gasUrl = await promptAndSetGasUrl();
            if (!gasUrl) {
                showStatus("GAS URL未設定のため中断", 5000);
                return;
            }
        }

        // ターゲット要素を特定
        let targetBody = null;
        try {
            const result = await waitForSyncTarget(10000); // 10秒待機
            targetBody = result.el;
            console.log(`【fire-trajectory】対象テーブルを検出しました (Selector: ${result.selector})`);
        } catch (e) {
            showStatus("エラー: 明細表が見つかりません", 10000);
            console.error(e);
            diagnoseDOM();
            return;
        }

        const scrapeCurrentPage = () => {
            // 再取得 (tbodyがなければ table 全体から探すなど柔軟に)
            const currentBody = document.querySelector('#transaction_list_body') ||
                document.querySelector('.js-transaction_table tbody') ||
                document.querySelector('table.transaction_table tbody');

            if (!currentBody) {
                console.warn("明細テーブルが再取得できません");
                return [];
            }

            const rows = currentBody.querySelectorAll('tr');
            const data = [];
            rows.forEach(row => {
                // セレクタを少し緩くする (クラス名が完全一致でなくても部分一致などで取れるように調整)
                const getText = (cls) => row.querySelector(`.${cls}`)?.innerText.trim();

                const date = getText('date');
                const content = getText('content');
                const amountRaw = getText('amount');
                const source = getText('source') || row.querySelector('.account')?.innerText.trim(); // source または account
                const category = getText('category'); // 大項目・中項目が結合されている場合がある

                if (date && content && amountRaw) { // 最低限これらがあれば良しとする
                    const amount = amountRaw.replace(/[,円\s]/g, '');
                    const uniqueString = `${date}-${content}-${amount}-${source}-${category}`;
                    const hashId = CryptoJS.SHA256(uniqueString).toString(CryptoJS.enc.Hex);
                    data.push({ id: hashId, date, content, amount, source, category });
                }
            });
            return data;
        };

        try {
            // 1. GASから同期モードを取得
            showStatus("GASへ接続中...");
            const resConfig = await fetchWithRetry(gasUrl, {
                method: "POST",
                body: JSON.stringify({ action: "get_sync_config" })
            });
            const syncSettings = await resConfig.json();
            if (syncSettings.status === 'error') throw new Error(syncSettings.message);

            showStatus(`モード: ${syncSettings.mode} で同期開始`);

            const monthsToSync = syncSettings.mode === 'Full' ? 52 : 6;
            let allData = [];

            // 2. 複数月のデータをスクレイピング
            for (let i = 0; i < monthsToSync; i++) {
                showStatus(`データ取得中: ${i + 1}ヶ月目`);

                if (i > 0) await new Promise(r => setTimeout(r, 1500)); // ページ遷移後の描画待ちを少し長めに

                const data = scrapeCurrentPage();
                console.log(`Month ${i + 1}: ${data.length} items found.`);
                allData.push(...data);

                if (i < monthsToSync - 1) {
                    // 「前の月へ」ボタンのセレクタも強化
                    const prevButtons = [
                        '#bda-in-closing-month-asset a:first-child', // 振替なし表示
                        '.transaction_list .pagination .prev a',     // 一般的なページネーション
                        'a.btn-check-previous-month',                 // 仮定: ボタンクラス
                        '.fc-header-left .fc-button-prev'            // カレンダー形式の場合?
                    ];

                    let prevMonthButton = null;
                    for (const sel of prevButtons) {
                        prevMonthButton = document.querySelector(sel);
                        if (prevMonthButton) break;
                    }

                    if (prevMonthButton) {
                        try {
                            prevMonthButton.click();
                            // ローディング表示があれば消えるのを待つ
                            await waitForElementToDisappear('#loading', '#loading-overlay');
                        } catch (err) {
                            console.warn("ページ遷移エラー", err);
                            break;
                        }
                    } else {
                        console.warn("「前の月へ」ボタンが見つかりません。ループを終了します。");
                        break;
                    }
                }
            }

            const uniqueData = allData.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
            showStatus(`${uniqueData.length}件のデータを送信中...`);

            // 3. GASへデータを送信
            if (uniqueData.length > 0) {
                const resSync = await fetchWithRetry(gasUrl, {
                    method: "POST",
                    body: JSON.stringify({ action: "sync_data", data: uniqueData })
                });
                const result = await resSync.json();
                if (result.status === 'error') throw new Error(result.message);
                showStatus(`完了: ${result.count}件同期しました`, 5000);
            } else {
                showStatus("送信するデータがありません", 3000);
            }

            console.log("完了。");
            setTimeout(() => { window.close(); }, 3000);

        } catch (e) {
            console.error(e);
            showStatus(`エラー: ${e.message}`, 10000);
            alert(`エラーが発生しました: ${e.message}`);
        }
    }

    // 初期化処理
    try {
        addStyles();
        showStatus("MF Sync: 待機中...");

        // 実行開始 (waitForSyncTarget内で待機する)
        runSync();
    } catch (e) {
        console.error("Critical Error", e);
    }
})();